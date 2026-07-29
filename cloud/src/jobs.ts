import type { Pool, PoolClient } from 'pg';

import { releaseJobCost, settleClaimedJobCost } from './billing.js';

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_RETRY_BASE_MS = 1_000;
const JOB_OUTCOME = Symbol('job-outcome');

export type ClaimedJob = {
  id: string;
  userId: string;
  type: string;
  input: unknown;
  attemptCount: number;
  maxAttempts: number;
  timeoutSeconds: number;
  leaseToken: string;
  reservedCostMicros: string;
};

export type JobHandler = (
  job: ClaimedJob,
  signal: AbortSignal,
) => Promise<unknown>;

export type JobHandlers = ReadonlyMap<string, JobHandler>;

type JobOutcome = {
  readonly [JOB_OUTCOME]: true;
  readonly result: unknown;
  readonly actualCostMicros: bigint;
};

export function jobOutcome(
  result: unknown,
  actualCostMicros: bigint,
): JobOutcome {
  if (actualCostMicros < 0n) throw jobError('job_actual_cost_invalid');
  return {
    [JOB_OUTCOME]: true,
    result,
    actualCostMicros,
  };
}

export type JobSnapshot = {
  id: string;
  type: string;
  status: 'queued' | 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attemptCount: number;
  maxAttempts: number;
  timeoutSeconds: number;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  user_id: string;
  type: string;
  input_json: unknown;
  status: JobSnapshot['status'];
  attempt_count: number;
  max_attempts: number;
  timeout_seconds: number;
  lease_token: string;
  reserved_cost_micros: string;
};

export async function getUserJob(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<JobSnapshot | null> {
  const result = await pool.query<{
    id: string;
    type: string;
    status: JobSnapshot['status'];
    attempt_count: number;
    max_attempts: number;
    timeout_seconds: number;
    cancel_requested_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, type, status, attempt_count, max_attempts, timeout_seconds,
            cancel_requested_at, created_at, updated_at
     FROM jobs
     WHERE user_id = $1 AND id = $2`,
    [userId, jobId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        type: row.type,
        status: row.status,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        timeoutSeconds: row.timeout_seconds,
        cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }
    : null;
}

export async function requestJobCancellation(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<JobSnapshot | null> {
  await pool.query(
    `UPDATE jobs
     SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
         updated_at = now()
     WHERE user_id = $1
       AND id = $2
       AND status IN ('queued', 'reserved', 'running')`,
    [userId, jobId],
  );
  return getUserJob(pool, userId, jobId);
}

export async function claimNextJob(
  pool: Pool,
  workerId: string,
  supportedTypes: readonly string[],
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<ClaimedJob | null> {
  if (!supportedTypes.length) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query<{
      id: string;
      user_id: string;
    }>(
      `WITH per_user AS MATERIALIZED (
         SELECT DISTINCT ON (job.user_id)
           job.id, job.user_id, job.available_at, job.created_at
         FROM jobs AS job
         WHERE job.status IN ('queued', 'reserved')
           AND job.cancel_requested_at IS NULL
           AND job.available_at <= now()
           AND job.type = ANY($1::text[])
           AND (
             job.type NOT IN ('ai.text', 'ai.image', 'ai.video', 'ai.transcription')
             OR (
               job.status = 'reserved'
               AND job.reserved_cost_micros > 0
             )
             OR (
               job.status = 'queued'
               AND job.estimated_cost_micros = 0
               AND job.reserved_cost_micros = 0
               AND job.confirmed_at IS NOT NULL
             )
           )
         ORDER BY job.user_id, job.available_at, job.created_at, job.id
       )
       SELECT job.id, job.user_id
       FROM jobs AS job
       JOIN per_user AS candidate ON candidate.id = job.id
       LEFT JOIN worker_user_fairness AS fairness
         ON fairness.user_id = job.user_id
       ORDER BY fairness.last_claimed_at ASC NULLS FIRST,
                candidate.available_at,
                candidate.created_at,
                candidate.id
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1`,
      [supportedTypes],
    );
    const selected = candidate.rows[0];
    if (!selected) {
      await client.query('COMMIT');
      return null;
    }

    const claimed = await client.query<JobRow>(
      `UPDATE jobs
       SET status = 'running',
           attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => $3),
           worker_id = $4,
           last_heartbeat_at = now(),
           started_at = COALESCE(started_at, now()),
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, type, input_json, status, attempt_count,
                 max_attempts, timeout_seconds, lease_token,
                 reserved_cost_micros`,
      [selected.id, selected.user_id, leaseSeconds, workerId],
    );
    const row = requiredRow(claimed.rows[0]);
    await client.query(
      `INSERT INTO job_attempts (
         user_id, job_id, attempt_number, lease_token, worker_id
       ) VALUES ($1, $2, $3, $4, $5)`,
      [row.user_id, row.id, row.attempt_count, row.lease_token, workerId],
    );
    await client.query(
      `INSERT INTO worker_user_fairness (user_id, last_claimed_at)
       VALUES ($1, now())
       ON CONFLICT (user_id)
       DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at`,
      [row.user_id],
    );
    await client.query('COMMIT');
    return claimedJob(row);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function runNextJob(
  pool: Pool,
  workerId: string,
  handlers: JobHandlers,
  options: {
    leaseSeconds?: number;
    heartbeatMs?: number;
    retryBaseMs?: number;
  } = {},
): Promise<boolean> {
  const job = await claimNextJob(
    pool,
    workerId,
    [...handlers.keys()],
    options.leaseSeconds,
  );
  if (!job) return false;
  const handler = handlers.get(job.type);
  if (!handler) throw new Error(`No handler registered for ${job.type}`);

  const controller = new AbortController();
  let abortCode: 'job_cancelled' | 'job_timed_out' | null = null;
  const timeout = setTimeout(() => {
    abortCode = 'job_timed_out';
    controller.abort(new Error(abortCode));
  }, job.timeoutSeconds * 1_000);
  const heartbeat = setInterval(() => {
    void heartbeatJob(pool, job, options.leaseSeconds).then((active) => {
      if (!active && !controller.signal.aborted) {
        abortCode = 'job_cancelled';
        controller.abort(new Error(abortCode));
      }
    });
  }, options.heartbeatMs ?? 1_000);

  try {
    const result = await Promise.race([
      handler(job, controller.signal),
      rejectWhenAborted(controller.signal),
    ]);
    await completeJob(pool, job, result);
  } catch (error) {
    const code =
      abortCode ??
      normalizeErrorCode(error instanceof Error ? error.name : 'job_failed');
    if (code === 'job_cancelled') {
      await cancelRunningJob(pool, job);
      await releaseReservation(pool, job, 'cancelled', 'worker-cancel');
    } else {
      const terminal = await failJob(
        pool,
        job,
        code,
        code === 'job_timed_out' ? 'timed_out' : 'failed',
        options.retryBaseMs,
      );
      if (terminal) {
        await releaseReservation(pool, job, 'failed', 'worker-failure');
      }
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
  return true;
}

export async function processNextCancellation(
  pool: Pool,
): Promise<{ jobId: string; userId: string; reservedCostMicros: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      id: string;
      user_id: string;
      reserved_cost_micros: string;
    }>(
      `WITH candidate AS (
         SELECT id
         FROM jobs
         WHERE status IN ('queued', 'reserved')
           AND cancel_requested_at IS NOT NULL
         ORDER BY cancel_requested_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs
       SET status = 'cancelled',
           error_code = 'job_cancelled',
           finished_at = now(),
           updated_at = now()
       WHERE id = (SELECT id FROM candidate)
       RETURNING id, user_id, reserved_cost_micros`,
    );
    await client.query('COMMIT');
    const row = result.rows[0];
    if (!row) return null;
    if (BigInt(row.reserved_cost_micros) > 0n) {
      await releaseJobCost(
        pool,
        row.user_id,
        row.id,
        'cancelled',
        `queued-cancel:${row.id}`,
      );
    }
    return {
      jobId: row.id,
      userId: row.user_id,
      reservedCostMicros: row.reserved_cost_micros,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverNextExpiredLease(
  pool: Pool,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
): Promise<{
  jobId: string;
  userId: string;
  terminal: boolean;
  reservedCostMicros: string;
} | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<JobRow & { cancel_requested_at: Date | null }>(
      `SELECT id, user_id, type, input_json, status, attempt_count,
              max_attempts, timeout_seconds, lease_token,
              reserved_cost_micros, cancel_requested_at
       FROM jobs
       WHERE status = 'running'
         AND lease_expires_at <= now()
       ORDER BY lease_expires_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const job = result.rows[0];
    if (!job) {
      await client.query('COMMIT');
      return null;
    }
    const cancelled = job.cancel_requested_at !== null;
    const terminal = cancelled || job.attempt_count >= job.max_attempts;
    const nextStatus = cancelled
      ? 'cancelled'
      : terminal
        ? 'failed'
        : BigInt(job.reserved_cost_micros) > 0n
          ? 'reserved'
          : 'queued';
    const nextAvailableAt = new Date(
      Date.now() + retryDelayMs(job.attempt_count, retryBaseMs),
    );
    await client.query(
      `UPDATE job_attempts
       SET status = 'lease_expired',
           error_code = 'worker_lease_expired',
           finished_at = now()
       WHERE user_id = $1 AND job_id = $2 AND lease_token = $3
         AND status = 'running'`,
      [job.user_id, job.id, job.lease_token],
    );
    const finalErrorCode = cancelled
      ? 'job_cancelled'
      : 'worker_lease_expired';
    await client.query(
      `UPDATE jobs
       SET status = $1,
           error_code = $2,
           available_at = CASE WHEN $3 THEN available_at ELSE $4 END,
           finished_at = CASE WHEN $3 THEN now() ELSE NULL END,
           lease_token = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           last_heartbeat_at = NULL,
           updated_at = now()
       WHERE user_id = $5 AND id = $6`,
      [
        nextStatus,
        finalErrorCode,
        terminal,
        nextAvailableAt,
        job.user_id,
        job.id,
      ],
    );
    await client.query('COMMIT');
    const recovered = {
      jobId: job.id,
      userId: job.user_id,
      terminal,
      reservedCostMicros: job.reserved_cost_micros,
    };
    if (terminal && BigInt(job.reserved_cost_micros) > 0n) {
      await releaseJobCost(
        pool,
        job.user_id,
        job.id,
        cancelled ? 'cancelled' : 'failed',
        `expired-lease:${job.id}`,
      );
    }
    return recovered;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function heartbeatJob(
  pool: Pool,
  job: ClaimedJob,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs
     SET lease_expires_at = now() + make_interval(secs => $1),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE user_id = $2 AND id = $3
       AND status = 'running'
       AND lease_token = $4
       AND cancel_requested_at IS NULL`,
    [leaseSeconds, job.userId, job.id, job.leaseToken],
  );
  return result.rowCount === 1;
}

async function completeJob(
  pool: Pool,
  job: ClaimedJob,
  result: unknown,
): Promise<void> {
  const outcome = isJobOutcome(result) ? result : null;
  const reservedCostMicros = BigInt(job.reservedCostMicros);
  if (reservedCostMicros > 0n && !outcome) {
    throw jobError('job_actual_cost_missing');
  }
  const actualCostMicros = outcome?.actualCostMicros ?? 0n;
  if (actualCostMicros > reservedCostMicros) {
    throw jobError('actual_cost_exceeds_reservation');
  }
  const serializedResult = JSON.stringify(outcome?.result ?? result ?? null);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (reservedCostMicros > 0n) {
      await settleClaimedJobCost(client, {
        userId: job.userId,
        jobId: job.id,
        leaseToken: job.leaseToken,
        actualCostMicros,
        idempotencyKey: `worker-settle:${job.id}`,
      });
    }
    const completed = await client.query(
      `UPDATE jobs
       SET status = 'succeeded',
           result_json = $1::jsonb,
           error_code = NULL,
           actual_cost_micros = $2,
           reserved_cost_micros = 0,
           finished_at = now(),
           lease_token = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           last_heartbeat_at = NULL,
           updated_at = now()
       WHERE user_id = $3 AND id = $4
         AND status = 'running'
         AND lease_token = $5
         AND cancel_requested_at IS NULL`,
      [
        serializedResult,
        actualCostMicros.toString(),
        job.userId,
        job.id,
        job.leaseToken,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new Error('job_lease_lost');
    }
    await finishAttempt(client, job, 'succeeded', null);
    await client.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function failJob(
  pool: Pool,
  job: ClaimedJob,
  errorCode: string,
  attemptStatus: 'failed' | 'timed_out',
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockClaimedJob(client, job);
    if (!current) {
      await client.query('ROLLBACK');
      return false;
    }
    const terminal = job.attemptCount >= job.maxAttempts;
    const nextStatus = terminal
      ? 'failed'
      : BigInt(job.reservedCostMicros) > 0n
        ? 'reserved'
        : 'queued';
    await client.query(
      `UPDATE jobs
       SET status = $1,
           error_code = $2,
           available_at = $3,
           finished_at = CASE WHEN $4 THEN now() ELSE NULL END,
           lease_token = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           last_heartbeat_at = NULL,
           updated_at = now()
       WHERE user_id = $5 AND id = $6`,
      [
        nextStatus,
        errorCode,
        new Date(Date.now() + retryDelayMs(job.attemptCount, retryBaseMs)),
        terminal,
        job.userId,
        job.id,
      ],
    );
    await finishAttempt(client, job, attemptStatus, errorCode);
    await client.query('COMMIT');
    return terminal;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function releaseReservation(
  pool: Pool,
  job: ClaimedJob,
  status: 'failed' | 'cancelled',
  keyPrefix: string,
): Promise<void> {
  if (BigInt(job.reservedCostMicros) === 0n) return;
  await releaseJobCost(
    pool,
    job.userId,
    job.id,
    status,
    `${keyPrefix}:${job.id}`,
  );
}

async function cancelRunningJob(pool: Pool, job: ClaimedJob): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cancelled = await client.query(
      `UPDATE jobs
       SET status = 'cancelled',
           error_code = 'job_cancelled',
           finished_at = now(),
           lease_token = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           last_heartbeat_at = NULL,
           updated_at = now()
       WHERE user_id = $1 AND id = $2
         AND status = 'running' AND lease_token = $3`,
      [job.userId, job.id, job.leaseToken],
    );
    if (cancelled.rowCount === 1) {
      await finishAttempt(client, job, 'cancelled', 'job_cancelled');
    }
    await client.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function lockClaimedJob(
  client: PoolClient,
  job: ClaimedJob,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM jobs
     WHERE user_id = $1 AND id = $2
       AND status = 'running' AND lease_token = $3
     FOR UPDATE`,
    [job.userId, job.id, job.leaseToken],
  );
  return result.rowCount === 1;
}

async function finishAttempt(
  client: PoolClient,
  job: ClaimedJob,
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
  errorCode: string | null,
): Promise<void> {
  await client.query(
    `UPDATE job_attempts
     SET status = $1, error_code = $2, finished_at = now()
     WHERE user_id = $3 AND job_id = $4 AND lease_token = $5
       AND status = 'running'`,
    [status, errorCode, job.userId, job.id, job.leaseToken],
  );
}

function claimedJob(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    input: row.input_json,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    timeoutSeconds: row.timeout_seconds,
    leaseToken: row.lease_token,
    reservedCostMicros: row.reserved_cost_micros,
  };
}

function retryDelayMs(attemptCount: number, baseMs: number): number {
  return Math.min(5 * 60_000, baseMs * 2 ** Math.max(0, attemptCount - 1));
}

function normalizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'job_failed';
}

function isJobOutcome(value: unknown): value is JobOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    JOB_OUTCOME in value &&
    (value as JobOutcome)[JOB_OUTCOME] === true
  );
}

function jobError(code: string): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error.
  }
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

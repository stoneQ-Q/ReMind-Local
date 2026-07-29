import type { Pool, PoolClient } from 'pg';

import { assertProviderAvailable } from './provider-health.js';

const BILLING_GLOBAL_LOCK_ID = 7_214_306_302;

export type BillingErrorCode =
  | 'account_not_found'
  | 'job_not_found'
  | 'job_not_reservable'
  | 'job_not_settleable'
  | 'job_not_releasable'
  | 'invalid_amount'
  | 'insufficient_balance'
  | 'job_cost_limit_exceeded'
  | 'user_daily_limit_exceeded'
  | 'user_monthly_limit_exceeded'
  | 'platform_daily_limit_exceeded'
  | 'platform_monthly_limit_exceeded'
  | 'actual_cost_exceeds_reservation'
  | 'high_cost_confirmation_required'
  | 'quote_amount_mismatch'
  | 'quote_expired'
  | 'idempotency_conflict';

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode) {
    super(code);
  }
}

export type BillingAccountSnapshot = {
  currency: 'CNY';
  balanceMicros: string;
  reservedMicros: string;
  availableMicros: string;
  dailyLimitMicros: string;
  monthlyLimitMicros: string;
  updatedAt: string;
};

export type LedgerEntry = {
  id: string;
  jobId: string | null;
  kind: 'top_up' | 'reserve' | 'settle' | 'release' | 'refund' | 'adjustment';
  amountMicros: string;
  balanceDeltaMicros: string;
  reservedDeltaMicros: string;
  balanceAfterMicros: string;
  reservedAfterMicros: string;
  createdAt: string;
};

type AccountRow = {
  id: string;
  currency: 'CNY';
  balance_micros: string;
  reserved_micros: string;
  daily_limit_micros: string;
  monthly_limit_micros: string;
  updated_at: Date;
};

type JobRow = {
  id: string;
  user_id: string;
  status: 'queued' | 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  estimated_cost_micros: string;
  reserved_cost_micros: string;
  provider: string | null;
  confirmation_required: boolean;
  confirmed_at: Date | null;
  quote_expires_at: Date | null;
};

type PolicyRow = {
  max_job_cost_micros: string;
  high_cost_confirmation_threshold_micros: string;
  platform_daily_limit_micros: string;
  platform_monthly_limit_micros: string;
};

export async function getBillingAccount(
  pool: Pool,
  userId: string,
): Promise<BillingAccountSnapshot | null> {
  const result = await pool.query<AccountRow>(
    `SELECT id, currency, balance_micros, reserved_micros,
            daily_limit_micros, monthly_limit_micros, updated_at
     FROM billing_accounts
     WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ? accountSnapshot(result.rows[0]) : null;
}

export async function listLedgerEntries(
  pool: Pool,
  userId: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await pool.query<{
    id: string;
    job_id: string | null;
    kind: LedgerEntry['kind'];
    amount_micros: string;
    balance_delta_micros: string;
    reserved_delta_micros: string;
    balance_after_micros: string;
    reserved_after_micros: string;
    created_at: Date;
  }>(
    `SELECT id, job_id, kind, amount_micros, balance_delta_micros,
            reserved_delta_micros, balance_after_micros,
            reserved_after_micros, created_at
     FROM ledger_entries
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [userId, safeLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    amountMicros: row.amount_micros,
    balanceDeltaMicros: row.balance_delta_micros,
    reservedDeltaMicros: row.reserved_delta_micros,
    balanceAfterMicros: row.balance_after_micros,
    reservedAfterMicros: row.reserved_after_micros,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Internal credit primitive. This must only be called after a trusted payment
 * callback or by an audited operator tool; it is intentionally not an API route.
 */
export async function creditBalance(
  pool: Pool,
  userId: string,
  amountMicros: bigint,
  idempotencyKey: string,
  metadata: Record<string, unknown> = {},
): Promise<BillingAccountSnapshot> {
  requirePositiveAmount(amountMicros);
  return withBillingTransaction(pool, async (client) => {
    const existing = await findIdempotentEntry(
      client,
      userId,
      idempotencyKey,
      null,
      'top_up',
      amountMicros,
    );
    if (existing) return accountSnapshot(await requireAccount(client, userId));

    const account = await requireAccount(client, userId);
    const updated = await updateAccount(
      client,
      userId,
      amountMicros,
      0n,
    );
    await appendLedgerEntry(client, {
      userId,
      accountId: account.id,
      jobId: null,
      kind: 'top_up',
      amountMicros,
      balanceDeltaMicros: amountMicros,
      reservedDeltaMicros: 0n,
      account: updated,
      idempotencyKey,
      metadata,
    });
    return accountSnapshot(updated);
  });
}

export async function reserveJobCost(
  pool: Pool,
  userId: string,
  jobId: string,
  estimateMicros: bigint,
  idempotencyKey: string,
): Promise<BillingAccountSnapshot> {
  requirePositiveAmount(estimateMicros);
  return withBillingTransaction(pool, async (client) => {
    const existing = await findIdempotentEntry(
      client,
      userId,
      idempotencyKey,
      jobId,
      'reserve',
      estimateMicros,
    );
    if (existing) return accountSnapshot(await requireAccount(client, userId));

    const account = await requireAccount(client, userId);
    const job = await requireJob(client, userId, jobId);
    if (job.status !== 'queued') throw new BillingError('job_not_reservable');
    if (job.quote_expires_at && job.quote_expires_at.getTime() <= Date.now()) {
      throw new BillingError('quote_expired');
    }
    if (
      job.quote_expires_at &&
      BigInt(job.estimated_cost_micros) !== estimateMicros
    ) {
      throw new BillingError('quote_amount_mismatch');
    }
    if (job.provider) {
      await assertProviderAvailable(client, job.provider);
    }

    const policy = await requirePolicy(client);
    if (estimateMicros > BigInt(policy.max_job_cost_micros)) {
      throw new BillingError('job_cost_limit_exceeded');
    }
    if (
      (job.confirmation_required ||
        estimateMicros >=
          BigInt(policy.high_cost_confirmation_threshold_micros)) &&
      !job.confirmed_at
    ) {
      throw new BillingError('high_cost_confirmation_required');
    }
    const balance = BigInt(account.balance_micros);
    const reserved = BigInt(account.reserved_micros);
    if (estimateMicros > balance - reserved) {
      throw new BillingError('insufficient_balance');
    }

    const usage = await settledUsage(client, userId);
    enforceLimit(
      usage.userDaily + reserved + estimateMicros,
      BigInt(account.daily_limit_micros),
      'user_daily_limit_exceeded',
    );
    enforceLimit(
      usage.userMonthly + reserved + estimateMicros,
      BigInt(account.monthly_limit_micros),
      'user_monthly_limit_exceeded',
    );
    enforceLimit(
      usage.platformDaily + usage.platformReserved + estimateMicros,
      BigInt(policy.platform_daily_limit_micros),
      'platform_daily_limit_exceeded',
    );
    enforceLimit(
      usage.platformMonthly + usage.platformReserved + estimateMicros,
      BigInt(policy.platform_monthly_limit_micros),
      'platform_monthly_limit_exceeded',
    );

    const updated = await updateAccount(client, userId, 0n, estimateMicros);
    await client.query(
      `UPDATE jobs
       SET status = 'reserved',
           estimated_cost_micros = $1,
           reserved_cost_micros = $1,
           updated_at = now()
       WHERE user_id = $2 AND id = $3`,
      [estimateMicros.toString(), userId, jobId],
    );
    await appendLedgerEntry(client, {
      userId,
      accountId: account.id,
      jobId,
      kind: 'reserve',
      amountMicros: estimateMicros,
      balanceDeltaMicros: 0n,
      reservedDeltaMicros: estimateMicros,
      account: updated,
      idempotencyKey,
      metadata: {},
    });
    return accountSnapshot(updated);
  });
}

export async function settleJobCost(
  pool: Pool,
  userId: string,
  jobId: string,
  actualCostMicros: bigint,
  idempotencyKey: string,
): Promise<BillingAccountSnapshot> {
  requireNonnegativeAmount(actualCostMicros);
  return withBillingTransaction(pool, async (client) => {
    const settleKey = `${idempotencyKey}:settle`;
    const existing = await findIdempotentEntry(
      client,
      userId,
      settleKey,
      jobId,
      'settle',
      actualCostMicros,
    );
    if (existing) return accountSnapshot(await requireAccount(client, userId));

    const account = await requireAccount(client, userId);
    const job = await requireJob(client, userId, jobId);
    if (job.status !== 'reserved' && job.status !== 'running') {
      throw new BillingError('job_not_settleable');
    }
    const jobReserved = BigInt(job.reserved_cost_micros);
    if (actualCostMicros > jobReserved) {
      throw new BillingError('actual_cost_exceeds_reservation');
    }

    let updated = await updateAccount(
      client,
      userId,
      -actualCostMicros,
      -actualCostMicros,
    );
    await appendLedgerEntry(client, {
      userId,
      accountId: account.id,
      jobId,
      kind: 'settle',
      amountMicros: actualCostMicros,
      balanceDeltaMicros: -actualCostMicros,
      reservedDeltaMicros: -actualCostMicros,
      account: updated,
      idempotencyKey: settleKey,
      metadata: {},
    });

    const surplus = jobReserved - actualCostMicros;
    if (surplus > 0n) {
      updated = await updateAccount(client, userId, 0n, -surplus);
      await appendLedgerEntry(client, {
        userId,
        accountId: account.id,
        jobId,
        kind: 'release',
        amountMicros: surplus,
        balanceDeltaMicros: 0n,
        reservedDeltaMicros: -surplus,
        account: updated,
        idempotencyKey: `${idempotencyKey}:surplus`,
        metadata: { reason: 'unused_reservation' },
      });
    }
    await client.query(
      `UPDATE jobs
       SET status = 'succeeded',
           actual_cost_micros = $1,
           reserved_cost_micros = 0,
           finished_at = now(),
           updated_at = now()
       WHERE user_id = $2 AND id = $3`,
      [actualCostMicros.toString(), userId, jobId],
    );
    return accountSnapshot(updated);
  });
}

export async function releaseJobCost(
  pool: Pool,
  userId: string,
  jobId: string,
  finalStatus: 'failed' | 'cancelled',
  idempotencyKey: string,
): Promise<BillingAccountSnapshot> {
  return withBillingTransaction(pool, async (client) => {
    const releaseKey = `${idempotencyKey}:release`;
    const existing = await findIdempotentEntry(
      client,
      userId,
      releaseKey,
      jobId,
      'release',
    );
    if (existing) return accountSnapshot(await requireAccount(client, userId));

    const account = await requireAccount(client, userId);
    const job = await requireJob(client, userId, jobId);
    if (job.status !== 'reserved' && job.status !== 'running') {
      throw new BillingError('job_not_releasable');
    }
    const jobReserved = BigInt(job.reserved_cost_micros);
    const updated = await updateAccount(client, userId, 0n, -jobReserved);
    await appendLedgerEntry(client, {
      userId,
      accountId: account.id,
      jobId,
      kind: 'release',
      amountMicros: jobReserved,
      balanceDeltaMicros: 0n,
      reservedDeltaMicros: -jobReserved,
      account: updated,
      idempotencyKey: releaseKey,
      metadata: { reason: finalStatus },
    });
    await client.query(
      `UPDATE jobs
       SET status = $1,
           reserved_cost_micros = 0,
           finished_at = now(),
           updated_at = now()
       WHERE user_id = $2 AND id = $3`,
      [finalStatus, userId, jobId],
    );
    return accountSnapshot(updated);
  });
}

async function withBillingTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      BILLING_GLOBAL_LOCK_ID,
    ]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function requireAccount(
  client: PoolClient,
  userId: string,
): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `SELECT id, currency, balance_micros, reserved_micros,
            daily_limit_micros, monthly_limit_micros, updated_at
     FROM billing_accounts
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new BillingError('account_not_found');
  return row;
}

async function requireJob(
  client: PoolClient,
  userId: string,
  jobId: string,
): Promise<JobRow> {
  const result = await client.query<JobRow>(
    `SELECT id, user_id, status, estimated_cost_micros,
            reserved_cost_micros, provider, confirmation_required,
            confirmed_at, quote_expires_at
     FROM jobs
     WHERE user_id = $1 AND id = $2
     FOR UPDATE`,
    [userId, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new BillingError('job_not_found');
  return row;
}

async function requirePolicy(client: PoolClient): Promise<PolicyRow> {
  const result = await client.query<PolicyRow>(
    `SELECT max_job_cost_micros,
            high_cost_confirmation_threshold_micros,
            platform_daily_limit_micros, platform_monthly_limit_micros
     FROM billing_policy
     WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('billing policy is missing');
  return row;
}

async function updateAccount(
  client: PoolClient,
  userId: string,
  balanceDeltaMicros: bigint,
  reservedDeltaMicros: bigint,
): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `UPDATE billing_accounts
     SET balance_micros = balance_micros + $1,
         reserved_micros = reserved_micros + $2,
         updated_at = now()
     WHERE user_id = $3
     RETURNING id, currency, balance_micros, reserved_micros,
               daily_limit_micros, monthly_limit_micros, updated_at`,
    [balanceDeltaMicros.toString(), reservedDeltaMicros.toString(), userId],
  );
  const row = result.rows[0];
  if (!row) throw new BillingError('account_not_found');
  return row;
}

async function appendLedgerEntry(
  client: PoolClient,
  entry: {
    userId: string;
    accountId: string;
    jobId: string | null;
    kind: LedgerEntry['kind'];
    amountMicros: bigint;
    balanceDeltaMicros: bigint;
    reservedDeltaMicros: bigint;
    account: AccountRow;
    idempotencyKey: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries (
       user_id, billing_account_id, job_id, kind, amount_micros,
       balance_delta_micros, reserved_delta_micros,
       balance_after_micros, reserved_after_micros,
       idempotency_key, metadata_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
     )`,
    [
      entry.userId,
      entry.accountId,
      entry.jobId,
      entry.kind,
      entry.amountMicros.toString(),
      entry.balanceDeltaMicros.toString(),
      entry.reservedDeltaMicros.toString(),
      entry.account.balance_micros,
      entry.account.reserved_micros,
      entry.idempotencyKey,
      JSON.stringify(entry.metadata),
    ],
  );
}

async function findIdempotentEntry(
  client: PoolClient,
  userId: string,
  idempotencyKey: string,
  jobId: string | null,
  kind: LedgerEntry['kind'],
  expectedAmountMicros?: bigint,
): Promise<boolean> {
  const result = await client.query<{
    job_id: string | null;
    kind: string;
    amount_micros: string;
  }>(
    `SELECT job_id, kind, amount_micros
     FROM ledger_entries
     WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return false;
  if (
    row.job_id !== jobId ||
    row.kind !== kind ||
    (expectedAmountMicros !== undefined &&
      BigInt(row.amount_micros) !== expectedAmountMicros)
  ) {
    throw new BillingError('idempotency_conflict');
  }
  return true;
}

async function settledUsage(
  client: PoolClient,
  userId: string,
): Promise<{
  userDaily: bigint;
  userMonthly: bigint;
  platformDaily: bigint;
  platformMonthly: bigint;
  platformReserved: bigint;
}> {
  const result = await client.query<{
    user_daily: string;
    user_monthly: string;
    platform_daily: string;
    platform_monthly: string;
    platform_reserved: string;
  }>(
    `SELECT
       COALESCE(SUM(-balance_delta_micros) FILTER (
         WHERE user_id = $1
           AND kind = 'settle'
           AND created_at >= date_trunc('day', now())
       ), 0) AS user_daily,
       COALESCE(SUM(-balance_delta_micros) FILTER (
         WHERE user_id = $1
           AND kind = 'settle'
           AND created_at >= date_trunc('month', now())
       ), 0) AS user_monthly,
       COALESCE(SUM(-balance_delta_micros) FILTER (
         WHERE kind = 'settle'
           AND created_at >= date_trunc('day', now())
       ), 0) AS platform_daily,
       COALESCE(SUM(-balance_delta_micros) FILTER (
         WHERE kind = 'settle'
           AND created_at >= date_trunc('month', now())
       ), 0) AS platform_monthly,
       (SELECT COALESCE(SUM(reserved_micros), 0) FROM billing_accounts)
         AS platform_reserved
     FROM ledger_entries`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to calculate billing usage');
  return {
    userDaily: BigInt(row.user_daily),
    userMonthly: BigInt(row.user_monthly),
    platformDaily: BigInt(row.platform_daily),
    platformMonthly: BigInt(row.platform_monthly),
    platformReserved: BigInt(row.platform_reserved),
  };
}

function enforceLimit(
  projected: bigint,
  limit: bigint,
  code: BillingErrorCode,
): void {
  if (projected > limit) throw new BillingError(code);
}

function requirePositiveAmount(amount: bigint): void {
  if (amount <= 0n) throw new BillingError('invalid_amount');
}

function requireNonnegativeAmount(amount: bigint): void {
  if (amount < 0n) throw new BillingError('invalid_amount');
}

function accountSnapshot(row: AccountRow): BillingAccountSnapshot {
  const balance = BigInt(row.balance_micros);
  const reserved = BigInt(row.reserved_micros);
  return {
    currency: row.currency,
    balanceMicros: row.balance_micros,
    reservedMicros: row.reserved_micros,
    availableMicros: (balance - reserved).toString(),
    dailyLimitMicros: row.daily_limit_micros,
    monthlyLimitMicros: row.monthly_limit_micros,
    updatedAt: row.updated_at.toISOString(),
  };
}

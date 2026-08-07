import type { Pool, PoolClient } from 'pg';

const PROVIDER_HEALTH_LOCK_ID = 7_214_306_303;

export type ProviderStatus = {
  provider: string;
  status: 'active' | 'paused';
  consecutiveFailures: number;
  pausedAt: string | null;
  pauseReason: string | null;
};

type ProviderRow = {
  provider: string;
  status: ProviderStatus['status'];
  consecutive_failures: number;
  paused_at: Date | null;
  pause_reason: string | null;
};

export class ProviderPausedError extends Error {
  readonly code = 'provider_paused';

  constructor(readonly provider: string) {
    super('provider_paused');
  }
}

export async function assertProviderAvailable(
  client: PoolClient,
  provider: string,
): Promise<void> {
  const result = await client.query<{ status: ProviderStatus['status'] }>(
    `SELECT status FROM provider_health WHERE provider = $1`,
    [provider],
  );
  const status = result.rows[0]?.status;
  if (!status) throw new Error(`Unsupported provider: ${provider}`);
  if (status === 'paused') throw new ProviderPausedError(provider);
}

export async function recordProviderSuccess(
  pool: Pool,
  provider: string,
): Promise<ProviderStatus> {
  return withProviderTransaction(pool, async (client) => {
    const current = await requireProvider(client, provider);
    if (current.status === 'paused') return providerSnapshot(current);
    const result = await client.query<ProviderRow>(
      `UPDATE provider_health
       SET consecutive_failures = 0,
           failure_window_started_at = NULL,
           last_success_at = now(),
           updated_at = now()
       WHERE provider = $1
       RETURNING provider, status, consecutive_failures, paused_at, pause_reason`,
      [provider],
    );
    return providerSnapshot(requiredRow(result.rows[0]));
  });
}

export async function recordProviderFailure(
  pool: Pool,
  provider: string,
  errorCode: string,
): Promise<ProviderStatus> {
  const safeErrorCode = normalizeErrorCode(errorCode);
  return withProviderTransaction(pool, async (client) => {
    const current = await requireProvider(client, provider);
    if (current.status === 'paused') return providerSnapshot(current);

    const policy = await client.query<{
      provider_failure_threshold: number;
      provider_failure_window_seconds: number;
    }>(
      `SELECT provider_failure_threshold, provider_failure_window_seconds
       FROM billing_policy
       WHERE singleton = true`,
    );
    const settings = requiredRow(policy.rows[0]);
    const failure = await client.query<ProviderRow>(
      `UPDATE provider_health
       SET consecutive_failures = CASE
             WHEN failure_window_started_at IS NULL
               OR failure_window_started_at
                  < now() - make_interval(secs => $2)
             THEN 1
             ELSE consecutive_failures + 1
           END,
           failure_window_started_at = CASE
             WHEN failure_window_started_at IS NULL
               OR failure_window_started_at
                  < now() - make_interval(secs => $2)
             THEN now()
             ELSE failure_window_started_at
           END,
           last_failure_at = now(),
           updated_at = now()
       WHERE provider = $1
       RETURNING provider, status, consecutive_failures, paused_at, pause_reason`,
      [provider, settings.provider_failure_window_seconds],
    );
    let updated = requiredRow(failure.rows[0]);
    if (
      updated.consecutive_failures >= settings.provider_failure_threshold
    ) {
      const pauseReason = `consecutive_failures:${safeErrorCode}`;
      const paused = await client.query<ProviderRow>(
        `UPDATE provider_health
         SET status = 'paused',
             paused_at = now(),
             pause_reason = $2,
             updated_at = now()
         WHERE provider = $1
         RETURNING provider, status, consecutive_failures, paused_at, pause_reason`,
        [provider, pauseReason],
      );
      updated = requiredRow(paused.rows[0]);
      await client.query(
        `INSERT INTO operational_alerts (
           kind, severity, provider, message, metadata_json
         ) VALUES (
           'provider_auto_paused',
           'critical',
           $1,
           $2,
           $3::jsonb
         )`,
        [
          provider,
          `Provider ${provider} was automatically paused`,
          JSON.stringify({
            errorCode: safeErrorCode,
            consecutiveFailures: updated.consecutive_failures,
          }),
        ],
      );
      console.error(
        `Provider ${provider} automatically paused after ${updated.consecutive_failures} failures`,
      );
    }
    return providerSnapshot(updated);
  });
}

/**
 * Operator-only recovery primitive. Do not expose this as a public user route.
 */
export async function resumeProvider(
  pool: Pool,
  provider: string,
): Promise<ProviderStatus> {
  return withProviderTransaction(pool, async (client) => {
    await requireProvider(client, provider);
    const result = await client.query<ProviderRow>(
      `UPDATE provider_health
       SET status = 'active',
           consecutive_failures = 0,
           failure_window_started_at = NULL,
           paused_at = NULL,
           pause_reason = NULL,
           updated_at = now()
       WHERE provider = $1
       RETURNING provider, status, consecutive_failures, paused_at, pause_reason`,
      [provider],
    );
    return providerSnapshot(requiredRow(result.rows[0]));
  });
}

async function withProviderTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      PROVIDER_HEALTH_LOCK_ID,
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

async function requireProvider(
  client: PoolClient,
  provider: string,
): Promise<ProviderRow> {
  const result = await client.query<ProviderRow>(
    `SELECT provider, status, consecutive_failures, paused_at, pause_reason
     FROM provider_health
     WHERE provider = $1
     FOR UPDATE`,
    [provider],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Unsupported provider: ${provider}`);
  return row;
}

function normalizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'unknown';
}

function providerSnapshot(row: ProviderRow): ProviderStatus {
  return {
    provider: row.provider,
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    pausedAt: row.paused_at?.toISOString() ?? null,
    pauseReason: row.pause_reason,
  };
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

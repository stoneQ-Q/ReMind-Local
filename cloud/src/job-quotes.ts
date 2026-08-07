import type { Pool, PoolClient } from 'pg';

import { BillingError, reserveJobCost } from './billing.js';
import { assertProviderAvailable } from './provider-health.js';

const QUOTE_TTL_MINUTES = 15;
const supportedJobTypes = new Set([
  'ai.text',
  'ai.image',
  'ai.video',
  'ai.transcription',
  'media.pipeline',
]);

export type ManagedJobQuote = {
  jobId: string;
  type: string;
  provider: string;
  status: 'queued' | 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  estimatedCostMicros: string;
  confirmationRequired: boolean;
  confirmedAt: string | null;
  expiresAt: string;
};

type QuoteRow = {
  id: string;
  type: string;
  provider: string;
  status: ManagedJobQuote['status'];
  idempotency_key: string;
  estimated_cost_micros: string;
  confirmation_required: boolean;
  confirmed_at: Date | null;
  quote_expires_at: Date;
};

export class JobQuoteError extends Error {
  constructor(
    readonly code:
      | 'managed_mode_required'
      | 'unsupported_job_type'
      | 'quote_not_found'
      | 'quote_not_confirmable',
  ) {
    super(code);
  }
}

/**
 * Internal quote creation. The estimate must come from a trusted server-side
 * pricing calculator; there is intentionally no public API accepting a price.
 */
export async function createManagedJobQuote(
  pool: Pool,
  userId: string,
  type: string,
  provider: string,
  estimateMicros: bigint,
  idempotencyKey: string,
  input: Record<string, unknown> = {},
): Promise<ManagedJobQuote> {
  if (!supportedJobTypes.has(type)) {
    throw new JobQuoteError('unsupported_job_type');
  }
  if (estimateMicros <= 0n) throw new BillingError('invalid_amount');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ ai_mode: string }>(
      `SELECT ai_mode FROM users
       WHERE id = $1 AND status = 'active'
       FOR UPDATE`,
      [userId],
    );
    if (user.rows[0]?.ai_mode !== 'managed') {
      throw new JobQuoteError('managed_mode_required');
    }
    await assertProviderAvailable(client, provider);

    const policy = await client.query<{
      max_job_cost_micros: string;
      high_cost_confirmation_threshold_micros: string;
    }>(
      `SELECT max_job_cost_micros,
              high_cost_confirmation_threshold_micros
       FROM billing_policy
       WHERE singleton = true`,
    );
    const settings = policy.rows[0];
    if (!settings) throw new Error('billing policy is missing');
    if (estimateMicros > BigInt(settings.max_job_cost_micros)) {
      throw new BillingError('job_cost_limit_exceeded');
    }

    const existing = await client.query<QuoteRow>(
      `SELECT id, type, provider, status, idempotency_key,
              estimated_cost_micros, confirmation_required,
              confirmed_at, quote_expires_at
       FROM jobs
       WHERE user_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [userId, idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (
        prior.type !== type ||
        prior.provider !== provider ||
        BigInt(prior.estimated_cost_micros) !== estimateMicros
      ) {
        throw new BillingError('idempotency_conflict');
      }
      await client.query('COMMIT');
      return quoteSnapshot(prior);
    }

    const confirmationRequired =
      estimateMicros >=
      BigInt(settings.high_cost_confirmation_threshold_micros);
    const inserted = await client.query<QuoteRow>(
      `INSERT INTO jobs (
         user_id, type, provider, idempotency_key, input_json,
         estimated_cost_micros, confirmation_required, confirmed_at,
         quote_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7,
         CASE WHEN $7 THEN NULL ELSE now() END,
         now() + make_interval(mins => $8)
       )
       RETURNING id, type, provider, status, idempotency_key,
                 estimated_cost_micros, confirmation_required,
                 confirmed_at, quote_expires_at`,
      [
        userId,
        type,
        provider,
        idempotencyKey,
        JSON.stringify(input),
        estimateMicros.toString(),
        confirmationRequired,
        QUOTE_TTL_MINUTES,
      ],
    );
    await client.query('COMMIT');
    return quoteSnapshot(requiredRow(inserted.rows[0]));
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmManagedJobQuote(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<ManagedJobQuote> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<QuoteRow>(
      `SELECT id, type, provider, status, idempotency_key,
              estimated_cost_micros, confirmation_required,
              confirmed_at, quote_expires_at
       FROM jobs
       WHERE user_id = $1 AND id = $2
       FOR UPDATE`,
      [userId, jobId],
    );
    let quote = result.rows[0];
    if (!quote) throw new JobQuoteError('quote_not_found');
    if (quote.status !== 'queued') {
      if (quote.confirmed_at) {
        await client.query('COMMIT');
        return quoteSnapshot(quote);
      }
      throw new JobQuoteError('quote_not_confirmable');
    }
    if (quote.quote_expires_at.getTime() <= Date.now()) {
      throw new BillingError('quote_expired');
    }
    await assertProviderAvailable(client, quote.provider);
    if (!quote.confirmed_at) {
      const confirmed = await client.query<QuoteRow>(
        `UPDATE jobs
         SET confirmed_at = now(), updated_at = now()
         WHERE user_id = $1 AND id = $2
         RETURNING id, type, provider, status, idempotency_key,
                   estimated_cost_micros, confirmation_required,
                   confirmed_at, quote_expires_at`,
        [userId, jobId],
      );
      quote = requiredRow(confirmed.rows[0]);
    }
    await client.query('COMMIT');
    return quoteSnapshot(quote);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmAndReserveManagedJobQuote(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<{
  quote: ManagedJobQuote;
  account: Awaited<ReturnType<typeof reserveJobCost>>;
}> {
  const quote = await confirmManagedJobQuote(pool, userId, jobId);
  const account = await reserveJobCost(
    pool,
    userId,
    jobId,
    BigInt(quote.estimatedCostMicros),
    `quote-reserve:${jobId}`,
  );
  return {
    quote: { ...quote, status: 'reserved' },
    account,
  };
}

export async function getManagedJobQuote(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<ManagedJobQuote | null> {
  const result = await pool.query<QuoteRow>(
    `SELECT id, type, provider, status, idempotency_key,
            estimated_cost_micros, confirmation_required,
            confirmed_at, quote_expires_at
     FROM jobs
     WHERE user_id = $1 AND id = $2
       AND quote_expires_at IS NOT NULL`,
    [userId, jobId],
  );
  return result.rows[0] ? quoteSnapshot(result.rows[0]) : null;
}

function quoteSnapshot(row: QuoteRow): ManagedJobQuote {
  return {
    jobId: row.id,
    type: row.type,
    provider: row.provider,
    status: row.status,
    estimatedCostMicros: row.estimated_cost_micros,
    confirmationRequired: row.confirmation_required,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    expiresAt: row.quote_expires_at.toISOString(),
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original error.
  }
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

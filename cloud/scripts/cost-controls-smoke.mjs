import assert from 'node:assert/strict';

import pg from 'pg';

import {
  BillingError,
  creditBalance,
  releaseJobCost,
  reserveJobCost,
} from '../dist/billing.js';
import {
  confirmAndReserveManagedJobQuote,
  confirmManagedJobQuote,
  createManagedJobQuote,
  getManagedJobQuote,
} from '../dist/job-quotes.js';
import {
  ProviderPausedError,
  recordProviderFailure,
  recordProviderSuccess,
  resumeProvider,
} from '../dist/provider-health.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query(
    `UPDATE billing_policy
     SET max_job_cost_micros = 5000000,
         high_cost_confirmation_threshold_micros = 1000000,
         provider_failure_threshold = 3,
         provider_failure_window_seconds = 300,
         platform_daily_limit_micros = 100000000,
         platform_monthly_limit_micros = 1000000000
     WHERE singleton = true`,
  );

  const owner = await createManagedUser();
  const stranger = await createManagedUser();
  await creditBalance(pool, owner, 20_000_000n, 'payment:cost-controls');

  const highQuote = await createManagedJobQuote(
    pool,
    owner,
    'ai.video',
    'deepseek',
    1_500_000n,
    'quote:high',
    { sourceId: 'safe-test-input' },
  );
  assert.equal(highQuote.confirmationRequired, true);
  assert.equal(highQuote.confirmedAt, null);
  assert.equal(await getManagedJobQuote(pool, stranger, highQuote.jobId), null);

  await expectError(
    reserveJobCost(
      pool,
      owner,
      highQuote.jobId,
      1_500_000n,
      'reserve:high-before-confirm',
    ),
    BillingError,
    'high_cost_confirmation_required',
  );
  await expectError(
    reserveJobCost(
      pool,
      owner,
      highQuote.jobId,
      900_000n,
      'reserve:tampered-quote',
    ),
    BillingError,
    'quote_amount_mismatch',
  );

  const rawHighJob = await pool.query(
    `INSERT INTO jobs (user_id, type, idempotency_key)
     VALUES ($1, 'ai.video', 'raw-high-bypass')
     RETURNING id`,
    [owner],
  );
  await expectError(
    reserveJobCost(
      pool,
      owner,
      rawHighJob.rows[0].id,
      1_500_000n,
      'reserve:raw-high-bypass',
    ),
    BillingError,
    'high_cost_confirmation_required',
  );

  const confirmed = await confirmAndReserveManagedJobQuote(
    pool,
    owner,
    highQuote.jobId,
  );
  assert.equal(confirmed.quote.status, 'reserved');
  assert.ok(confirmed.quote.confirmedAt);
  assert.equal(confirmed.account.reservedMicros, '1500000');
  const confirmedAgain = await confirmAndReserveManagedJobQuote(
    pool,
    owner,
    highQuote.jobId,
  );
  assert.equal(confirmedAgain.account.reservedMicros, '1500000');
  await releaseJobCost(
    pool,
    owner,
    highQuote.jobId,
    'cancelled',
    'finish:high',
  );

  const lowQuote = await createManagedJobQuote(
    pool,
    owner,
    'ai.text',
    'deepseek',
    500_000n,
    'quote:low',
  );
  assert.equal(lowQuote.confirmationRequired, false);
  assert.ok(lowQuote.confirmedAt);
  await reserveJobCost(
    pool,
    owner,
    lowQuote.jobId,
    500_000n,
    'reserve:low',
  );
  await releaseJobCost(
    pool,
    owner,
    lowQuote.jobId,
    'cancelled',
    'finish:low',
  );

  const expired = await createManagedJobQuote(
    pool,
    owner,
    'ai.image',
    'deepseek',
    1_200_000n,
    'quote:expired',
  );
  await pool.query(
    `UPDATE jobs SET quote_expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [expired.jobId],
  );
  await expectError(
    confirmManagedJobQuote(pool, owner, expired.jobId),
    BillingError,
    'quote_expired',
  );

  assert.equal(
    (await recordProviderFailure(pool, 'deepseek', 'HTTP 503')).status,
    'active',
  );
  assert.equal(
    (await recordProviderFailure(pool, 'deepseek', 'HTTP 503')).status,
    'active',
  );
  const paused = await recordProviderFailure(pool, 'deepseek', 'HTTP 503');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.consecutiveFailures, 3);
  assert.match(paused.pauseReason, /^consecutive_failures:/);
  assert.equal(
    (await recordProviderFailure(pool, 'deepseek', 'HTTP 503')).status,
    'paused',
  );
  assert.equal(
    (await recordProviderSuccess(pool, 'deepseek')).status,
    'paused',
  );

  const alerts = await pool.query(
    `SELECT kind, severity, provider, metadata_json
     FROM operational_alerts
     WHERE provider = 'deepseek'`,
  );
  assert.equal(alerts.rowCount, 1);
  assert.equal(alerts.rows[0].kind, 'provider_auto_paused');
  assert.equal(alerts.rows[0].severity, 'critical');
  assert.equal(alerts.rows[0].metadata_json.errorCode, 'http_503');

  await expectError(
    createManagedJobQuote(
      pool,
      owner,
      'ai.text',
      'deepseek',
      300_000n,
      'quote:paused-provider',
    ),
    ProviderPausedError,
    'provider_paused',
  );

  const resumed = await resumeProvider(pool, 'deepseek');
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.consecutiveFailures, 0);

  await recordProviderFailure(pool, 'deepseek', 'timeout');
  await pool.query(
    `UPDATE provider_health
     SET failure_window_started_at = now() - interval '10 minutes'
     WHERE provider = 'deepseek'`,
  );
  const resetWindow = await recordProviderFailure(pool, 'deepseek', 'timeout');
  assert.equal(resetWindow.status, 'active');
  assert.equal(resetWindow.consecutiveFailures, 1);

  console.log(
    'cost controls smoke test passed: server quotes, explicit high-cost confirmation, expiry, provider circuit breaker, and durable alert',
  );
} finally {
  await pool.end();
}

async function createManagedUser() {
  const user = await pool.query(
    `INSERT INTO users (ai_mode) VALUES ('managed') RETURNING id`,
  );
  const userId = user.rows[0].id;
  await pool.query('INSERT INTO billing_accounts (user_id) VALUES ($1)', [userId]);
  return userId;
}

async function expectError(promise, ErrorType, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof ErrorType && error.code === code,
  );
}

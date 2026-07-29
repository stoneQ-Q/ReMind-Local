import assert from 'node:assert/strict';

import pg from 'pg';

import { creditBalance, reserveJobCost } from '../dist/billing.js';
import {
  claimNextJob,
  getUserJob,
  jobOutcome,
  processNextCancellation,
  recoverNextExpiredLease,
  requestJobCancellation,
  runNextJob,
} from '../dist/jobs.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const firstUser = await createUser();
  const secondUser = await createUser();

  let unauthorizedCalls = 0;
  const rawAiJob = await createJob(
    firstUser,
    'ai.video',
    'raw-ai-video',
    { prompt: 'must not run before authorization' },
  );
  const unreservedPaidAiJob = await createJob(
    secondUser,
    'ai.image',
    'unreserved-paid-ai-image',
    { prompt: 'must not run without a reservation' },
  );
  await pool.query(
    `UPDATE jobs
     SET confirmed_at = now(), estimated_cost_micros = 1000000
     WHERE id = $1`,
    [unreservedPaidAiJob],
  );
  assert.equal(
    await runNextJob(
      pool,
      'unauthorized-ai-worker',
      new Map([
        ['ai.video', async () => {
          unauthorizedCalls += 1;
          return { unauthorized: true };
        }],
        ['ai.image', async () => {
          unauthorizedCalls += 1;
          return { unauthorized: true };
        }],
      ]),
    ),
    false,
  );
  assert.equal(unauthorizedCalls, 0);
  assert.equal((await getUserJob(pool, firstUser, rawAiJob)).status, 'queued');
  assert.equal(
    (await getUserJob(pool, secondUser, unreservedPaidAiJob)).status,
    'queued',
  );

  const byokAiJob = await createJob(
    firstUser,
    'ai.transcription',
    'authorized-byok-ai',
    { audio: 'user-owned-provider-key' },
  );
  await authorizeJob(byokAiJob);
  let byokCalls = 0;
  await runNextJob(
    pool,
    'byok-ai-worker',
    new Map([
      ['ai.transcription', async () => {
        byokCalls += 1;
        return { text: 'authorized zero-cost result' };
      }],
    ]),
  );
  assert.equal(byokCalls, 1);
  assert.equal((await getUserJob(pool, firstUser, byokAiJob)).status, 'succeeded');
  await pool.query(
    'DELETE FROM worker_user_fairness WHERE user_id = ANY($1::uuid[])',
    [[firstUser, secondUser]],
  );

  const executionOrder = [];
  const successHandlers = new Map([
    [
      'test.success',
      async (job) => {
        executionOrder.push(job.userId);
        return { preserved: job.input };
      },
    ],
  ]);
  await createJob(firstUser, 'test.success', 'fair-a-1', {
    original: 'first-user-first',
  });
  await createJob(firstUser, 'test.success', 'fair-a-2', {
    original: 'first-user-second',
  });
  await createJob(secondUser, 'test.success', 'fair-b-1', {
    original: 'second-user',
  });
  await runNextJob(pool, 'fair-worker', successHandlers, { retryBaseMs: 0 });
  await runNextJob(pool, 'fair-worker', successHandlers, { retryBaseMs: 0 });
  await runNextJob(pool, 'fair-worker', successHandlers, { retryBaseMs: 0 });
  assert.deepEqual(executionOrder, [firstUser, secondUser, firstUser]);

  const concurrentJob = await createJob(
    firstUser,
    'test.concurrent',
    'concurrent',
    { original: 'claim-once' },
    { maxAttempts: 1 },
  );
  const concurrentClaims = await Promise.all([
    claimNextJob(pool, 'concurrent-worker-a', ['test.concurrent'], 1),
    claimNextJob(pool, 'concurrent-worker-b', ['test.concurrent'], 1),
  ]);
  assert.equal(concurrentClaims.filter(Boolean).length, 1);
  await pool.query(
    `UPDATE jobs SET lease_expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [concurrentJob],
  );
  const concurrentRecovery = await recoverNextExpiredLease(pool, 0);
  assert.equal(concurrentRecovery.terminal, true);

  let retryCalls = 0;
  const retryJob = await createJob(
    firstUser,
    'test.retry',
    'retry',
    { original: 'must-survive-retry' },
    { maxAttempts: 2 },
  );
  const retryHandlers = new Map([
    [
      'test.retry',
      async () => {
        retryCalls += 1;
        if (retryCalls === 1) throw new Error('transient failure');
        return { ok: true };
      },
    ],
  ]);
  await runNextJob(pool, 'retry-worker', retryHandlers, { retryBaseMs: 0 });
  assert.equal((await getUserJob(pool, firstUser, retryJob)).status, 'queued');
  await wait(20);
  await runNextJob(pool, 'retry-worker', retryHandlers, { retryBaseMs: 0 });
  assert.equal((await getUserJob(pool, firstUser, retryJob)).status, 'succeeded');
  assert.equal(retryCalls, 2);

  const timeoutJob = await createJob(
    firstUser,
    'test.timeout',
    'timeout',
    { original: 'must-survive-timeout' },
    { maxAttempts: 1, timeoutSeconds: 1 },
  );
  const timeoutHandlers = new Map([
    [
      'test.timeout',
      async () => new Promise(() => {}),
    ],
  ]);
  await runNextJob(pool, 'timeout-worker', timeoutHandlers, {
    heartbeatMs: 20,
  });
  assert.equal((await getUserJob(pool, firstUser, timeoutJob)).status, 'failed');

  const queuedCancellation = await createJob(
    firstUser,
    'test.success',
    'queued-cancel',
    { original: 'must-survive-cancel' },
  );
  assert.equal(
    await getUserJob(pool, secondUser, queuedCancellation),
    null,
  );
  await requestJobCancellation(pool, firstUser, queuedCancellation);
  await processNextCancellation(pool);
  assert.equal(
    (await getUserJob(pool, firstUser, queuedCancellation)).status,
    'cancelled',
  );

  const runningCancellation = await createJob(
    secondUser,
    'test.cancel-running',
    'running-cancel',
    { original: 'running-cancel-input' },
    { timeoutSeconds: 5 },
  );
  const runningCancelHandlers = new Map([
    [
      'test.cancel-running',
      async (_job, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    ],
  ]);
  const runningPromise = runNextJob(
    pool,
    'cancel-worker',
    runningCancelHandlers,
    { heartbeatMs: 20, leaseSeconds: 2 },
  );
  await wait(50);
  await requestJobCancellation(pool, secondUser, runningCancellation);
  await runningPromise;
  assert.equal(
    (await getUserJob(pool, secondUser, runningCancellation)).status,
    'cancelled',
  );

  const crashJob = await createJob(
    secondUser,
    'test.success',
    'crash-recovery',
    { original: 'must-survive-crash' },
    { maxAttempts: 2 },
  );
  const crashedClaim = await claimNextJob(
    pool,
    'crashed-worker',
    ['test.success'],
    1,
  );
  assert.equal(crashedClaim.id, crashJob);
  await pool.query(
    `UPDATE jobs SET lease_expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [crashJob],
  );
  const recovery = await recoverNextExpiredLease(pool, 0);
  assert.equal(recovery.terminal, false);
  await runNextJob(pool, 'recovery-worker', successHandlers, { retryBaseMs: 0 });
  assert.equal((await getUserJob(pool, secondUser, crashJob)).status, 'succeeded');

  const preservedInputs = await pool.query(
    `SELECT idempotency_key, input_json
     FROM jobs
     WHERE id = ANY($1::uuid[])
     ORDER BY idempotency_key`,
    [
      [
        retryJob,
        timeoutJob,
        queuedCancellation,
        runningCancellation,
        crashJob,
      ],
    ],
  );
  assert.deepEqual(
    preservedInputs.rows.map((row) => row.input_json.original),
    [
      'must-survive-crash',
      'must-survive-cancel',
      'must-survive-retry',
      'running-cancel-input',
      'must-survive-timeout',
    ],
  );

  const attempts = await pool.query(
    `SELECT job_id, attempt_number, status
     FROM job_attempts
     WHERE job_id = ANY($1::uuid[])
     ORDER BY job_id, attempt_number`,
    [[retryJob, timeoutJob, runningCancellation, crashJob]],
  );
  assert.equal(
    attempts.rows.some((attempt) => attempt.status === 'timed_out'),
    true,
  );
  assert.equal(
    attempts.rows.some((attempt) => attempt.status === 'cancelled'),
    true,
  );
  assert.equal(
    attempts.rows.some((attempt) => attempt.status === 'lease_expired'),
    true,
  );
  assert.equal(
    attempts.rows.filter((attempt) => attempt.job_id === retryJob).length,
    2,
  );

  await creditBalance(pool, firstUser, 5_000_000n, 'executor-credit');
  const paidFailureJob = await createJob(
    firstUser,
    'test.paid-failure',
    'paid-failure',
    { original: 'paid-failure-input' },
    { maxAttempts: 1 },
  );
  await pool.query('UPDATE jobs SET confirmed_at = now() WHERE id = $1', [
    paidFailureJob,
  ]);
  await reserveJobCost(
    pool,
    firstUser,
    paidFailureJob,
    1_500_000n,
    'reserve:paid-failure',
  );
  await runNextJob(
    pool,
    'paid-failure-worker',
    new Map([
      [
        'test.paid-failure',
        async () => {
          throw new Error('provider failed');
        },
      ],
    ]),
    { retryBaseMs: 0 },
  );
  const paidAccount = await pool.query(
    `SELECT balance_micros, reserved_micros
     FROM billing_accounts WHERE user_id = $1`,
    [firstUser],
  );
  assert.equal(paidAccount.rows[0].balance_micros, '5000000');
  assert.equal(paidAccount.rows[0].reserved_micros, '0');
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int AS count
         FROM ledger_entries
         WHERE user_id = $1 AND job_id = $2 AND kind = 'release'`,
        [firstUser, paidFailureJob],
      )
    ).rows[0].count,
    1,
  );

  const paidSuccessJob = await createJob(
    firstUser,
    'ai.video',
    'paid-success',
    { prompt: 'settle atomically' },
    { maxAttempts: 1 },
  );
  await authorizeJob(paidSuccessJob);
  await reserveJobCost(
    pool,
    firstUser,
    paidSuccessJob,
    1_000_000n,
    'reserve:paid-success',
  );
  await runNextJob(
    pool,
    'paid-success-worker',
    new Map([
      [
        'ai.video',
        async () => jobOutcome({ assetId: 'video-1' }, 600_000n),
      ],
    ]),
  );
  const paidSuccess = await pool.query(
    `SELECT status, result_json, actual_cost_micros, reserved_cost_micros
     FROM jobs WHERE id = $1`,
    [paidSuccessJob],
  );
  assert.deepEqual(paidSuccess.rows[0], {
    status: 'succeeded',
    result_json: { assetId: 'video-1' },
    actual_cost_micros: '600000',
    reserved_cost_micros: '0',
  });
  const paidSuccessAccount = await pool.query(
    `SELECT balance_micros, reserved_micros
     FROM billing_accounts WHERE user_id = $1`,
    [firstUser],
  );
  assert.deepEqual(paidSuccessAccount.rows[0], {
    balance_micros: '4400000',
    reserved_micros: '0',
  });
  const paidSuccessLedger = await pool.query(
    `SELECT kind, amount_micros
     FROM ledger_entries
     WHERE user_id = $1 AND job_id = $2
       AND kind IN ('settle', 'release')
     ORDER BY kind`,
    [firstUser, paidSuccessJob],
  );
  assert.deepEqual(paidSuccessLedger.rows, [
    { kind: 'settle', amount_micros: '600000' },
    { kind: 'release', amount_micros: '400000' },
  ]);

  const unsafePaidCases = [
    {
      type: 'ai.image',
      key: 'paid-missing-actual',
      handler: async () => ({ assetId: 'missing-cost' }),
      expectedError: 'job_actual_cost_missing',
    },
    {
      type: 'ai.text',
      key: 'paid-cost-overrun',
      handler: async () => jobOutcome({ text: 'too expensive' }, 1_100_000n),
      expectedError: 'actual_cost_exceeds_reservation',
    },
    {
      type: 'ai.video',
      key: 'paid-unserializable-result',
      handler: async () => jobOutcome({ invalidJson: 1n }, 600_000n),
      expectedError: 'typeerror',
    },
  ];
  for (const unsafeCase of unsafePaidCases) {
    const unsafeJob = await createJob(
      firstUser,
      unsafeCase.type,
      unsafeCase.key,
      { prompt: unsafeCase.key },
      { maxAttempts: 1 },
    );
    await authorizeJob(unsafeJob);
    await reserveJobCost(
      pool,
      firstUser,
      unsafeJob,
      1_000_000n,
      `reserve:${unsafeCase.key}`,
    );
    await runNextJob(
      pool,
      `worker:${unsafeCase.key}`,
      new Map([[unsafeCase.type, unsafeCase.handler]]),
      { retryBaseMs: 0 },
    );
    const unsafeState = await pool.query(
      `SELECT status, error_code, actual_cost_micros, reserved_cost_micros
       FROM jobs WHERE id = $1`,
      [unsafeJob],
    );
    assert.deepEqual(unsafeState.rows[0], {
      status: 'failed',
      error_code: unsafeCase.expectedError,
      actual_cost_micros: null,
      reserved_cost_micros: '0',
    });
    const unsafeLedger = await pool.query(
      `SELECT
         count(*) FILTER (WHERE kind = 'settle')::int AS settles,
         count(*) FILTER (WHERE kind = 'release')::int AS releases
       FROM ledger_entries
       WHERE user_id = $1 AND job_id = $2`,
      [firstUser, unsafeJob],
    );
    assert.deepEqual(unsafeLedger.rows[0], { settles: 0, releases: 1 });
  }
  const finalPaidAccount = await pool.query(
    `SELECT balance_micros, reserved_micros
     FROM billing_accounts WHERE user_id = $1`,
    [firstUser],
  );
  assert.deepEqual(finalPaidAccount.rows[0], {
    balance_micros: '4400000',
    reserved_micros: '0',
  });

  console.log(
    'job executor smoke test passed: AI authorization gate, BYOK execution, per-user fairness, single claim, retry, timeout, cancellation, lease recovery, tenant isolation, atomic paid settlement, and failure reservation release',
  );
} finally {
  await pool.end();
}

async function createUser() {
  const user = await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = user.rows[0].id;
  await pool.query('INSERT INTO billing_accounts (user_id) VALUES ($1)', [userId]);
  return userId;
}

async function createJob(
  userId,
  type,
  idempotencyKey,
  input,
  options = {},
) {
  const result = await pool.query(
    `INSERT INTO jobs (
       user_id, type, idempotency_key, input_json,
       max_attempts, timeout_seconds
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id`,
    [
      userId,
      type,
      idempotencyKey,
      JSON.stringify(input),
      options.maxAttempts ?? 3,
      options.timeoutSeconds ?? 10,
    ],
  );
  return result.rows[0].id;
}

async function authorizeJob(jobId) {
  await pool.query('UPDATE jobs SET confirmed_at = now() WHERE id = $1', [jobId]);
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

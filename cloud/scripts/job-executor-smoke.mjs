import assert from 'node:assert/strict';

import pg from 'pg';

import { creditBalance, reserveJobCost } from '../dist/billing.js';
import {
  claimNextJob,
  getUserJob,
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

  console.log(
    'job executor smoke test passed: per-user fairness, single claim, retry, timeout, queued/running cancellation, lease recovery, tenant isolation, input preservation, and final reservation release',
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

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

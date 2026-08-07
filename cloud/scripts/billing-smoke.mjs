import assert from 'node:assert/strict';

import pg from 'pg';

import {
  BillingError,
  creditBalance,
  getBillingAccount,
  listLedgerEntries,
  releaseJobCost,
  reserveJobCost,
  settleJobCost,
} from '../dist/billing.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const firstUser = await createUser();
  const secondUser = await createUser();

  await creditBalance(pool, firstUser, 20_000_000n, 'payment:first', {
    source: 'payment',
    internalReference: 'must-not-be-returned',
  });
  await creditBalance(pool, firstUser, 20_000_000n, 'payment:first', {
    source: 'payment',
    internalReference: 'must-not-be-returned',
  });
  await creditBalance(pool, secondUser, 20_000_000n, 'payment:second');
  assertAccount(await getBillingAccount(pool, firstUser), 20_000_000n, 0n);

  const settledJob = await createJob(firstUser, 'settled');
  await reserveJobCost(
    pool,
    firstUser,
    settledJob,
    4_000_000n,
    'reserve:settled',
  );
  await expectBillingError(
    reserveJobCost(
      pool,
      firstUser,
      settledJob,
      3_999_999n,
      'reserve:settled',
    ),
    'idempotency_conflict',
  );
  await reserveJobCost(
    pool,
    firstUser,
    settledJob,
    4_000_000n,
    'reserve:settled',
  );
  assertAccount(await getBillingAccount(pool, firstUser), 20_000_000n, 4_000_000n);

  await settleJobCost(
    pool,
    firstUser,
    settledJob,
    3_000_000n,
    'settle:settled',
  );
  await settleJobCost(
    pool,
    firstUser,
    settledJob,
    3_000_000n,
    'settle:settled',
  );
  assertAccount(await getBillingAccount(pool, firstUser), 17_000_000n, 0n);

  const failedJob = await createJob(firstUser, 'failed');
  await reserveJobCost(
    pool,
    firstUser,
    failedJob,
    2_000_000n,
    'reserve:failed',
  );
  await releaseJobCost(
    pool,
    firstUser,
    failedJob,
    'failed',
    'finish:failed',
  );
  await releaseJobCost(
    pool,
    firstUser,
    failedJob,
    'failed',
    'finish:failed',
  );
  assertAccount(await getBillingAccount(pool, firstUser), 17_000_000n, 0n);

  const concurrentJob = await createJob(firstUser, 'concurrent');
  await Promise.all([
    reserveJobCost(
      pool,
      firstUser,
      concurrentJob,
      1_000_000n,
      'reserve:concurrent',
    ),
    reserveJobCost(
      pool,
      firstUser,
      concurrentJob,
      1_000_000n,
      'reserve:concurrent',
    ),
  ]);
  assertAccount(await getBillingAccount(pool, firstUser), 17_000_000n, 1_000_000n);
  await releaseJobCost(
    pool,
    firstUser,
    concurrentJob,
    'cancelled',
    'finish:concurrent',
  );

  await expectBillingError(
    reserveJobCost(
      pool,
      firstUser,
      await createJob(firstUser, 'too-expensive'),
      6_000_000n,
      'reserve:too-expensive',
    ),
    'job_cost_limit_exceeded',
  );
  await pool.query(
    `UPDATE billing_accounts SET balance_micros = 3000000
     WHERE user_id = $1`,
    [secondUser],
  );
  await expectBillingError(
    reserveJobCost(
      pool,
      secondUser,
      await createJob(secondUser, 'insufficient'),
      4_000_000n,
      'reserve:insufficient',
    ),
    'insufficient_balance',
  );

  await pool.query(
    `UPDATE billing_accounts
     SET balance_micros = 10000000, daily_limit_micros = 3500000
     WHERE user_id = $1`,
    [secondUser],
  );
  const secondDailyJob = await createJob(secondUser, 'user-daily');
  await expectBillingError(
    reserveJobCost(
      pool,
      secondUser,
      secondDailyJob,
      3_600_000n,
      'reserve:user-daily',
    ),
    'user_daily_limit_exceeded',
  );

  await pool.query(
    `UPDATE billing_accounts
     SET balance_micros = 20000000,
         daily_limit_micros = 10000000,
         monthly_limit_micros = 3500000
     WHERE user_id = $1`,
    [firstUser],
  );
  await expectBillingError(
    reserveJobCost(
      pool,
      firstUser,
      await createJob(firstUser, 'user-monthly'),
      600_000n,
      'reserve:user-monthly',
    ),
    'user_monthly_limit_exceeded',
  );

  await pool.query(
    `UPDATE billing_accounts
     SET daily_limit_micros = 10000000, monthly_limit_micros = 100000000
     WHERE user_id = $1`,
    [firstUser],
  );
  await pool.query(
    `UPDATE billing_policy
     SET platform_daily_limit_micros = 3500000,
         platform_monthly_limit_micros = 1000000000
     WHERE singleton = true`,
  );
  await expectBillingError(
    reserveJobCost(
      pool,
      firstUser,
      await createJob(firstUser, 'platform-daily'),
      600_000n,
      'reserve:platform-daily',
    ),
    'platform_daily_limit_exceeded',
  );

  await pool.query(
    `UPDATE billing_policy
     SET platform_daily_limit_micros = 100000000,
         platform_monthly_limit_micros = 3500000
     WHERE singleton = true`,
  );
  await expectBillingError(
    reserveJobCost(
      pool,
      firstUser,
      await createJob(firstUser, 'platform-monthly'),
      600_000n,
      'reserve:platform-monthly',
    ),
    'platform_monthly_limit_exceeded',
  );

  const firstLedger = await listLedgerEntries(pool, firstUser, 100);
  const secondLedger = await listLedgerEntries(pool, secondUser, 100);
  assert.equal(firstLedger.some((entry) => entry.kind === 'settle'), true);
  assert.equal(firstLedger.some((entry) => entry.kind === 'release'), true);
  assert.equal(
    firstLedger.find((entry) => entry.kind === 'top_up')?.source,
    'payment',
  );
  assert.equal(
    JSON.stringify(firstLedger).includes('must-not-be-returned'),
    false,
  );
  assert.equal(secondLedger.length, 1);
  assert.equal(
    firstLedger.every(
      (entry) =>
        BigInt(entry.balanceAfterMicros) >= 0n &&
        BigInt(entry.reservedAfterMicros) >= 0n &&
        BigInt(entry.reservedAfterMicros) <= BigInt(entry.balanceAfterMicros),
    ),
    true,
  );

  await assert.rejects(
    pool.query(
      `UPDATE ledger_entries SET amount_micros = amount_micros + 1
       WHERE user_id = $1`,
      [firstUser],
    ),
    /append-only/,
  );
  await assert.rejects(
    pool.query(
      `UPDATE billing_accounts SET balance_micros = -1 WHERE user_id = $1`,
      [firstUser],
    ),
    /billing_accounts_balance_micros_check/,
  );

  console.log(
    'billing smoke test passed: immutable ledger, idempotent reserve/settle/release, hard limits, and nonnegative balances',
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

async function createJob(userId, key) {
  const result = await pool.query(
    `INSERT INTO jobs (user_id, type, idempotency_key, confirmed_at)
     VALUES ($1, 'billing.smoke', $2, now())
     RETURNING id`,
    [userId, key],
  );
  return result.rows[0].id;
}

function assertAccount(snapshot, balance, reserved) {
  assert.ok(snapshot);
  assert.equal(BigInt(snapshot.balanceMicros), balance);
  assert.equal(BigInt(snapshot.reservedMicros), reserved);
  assert.equal(BigInt(snapshot.availableMicros), balance - reserved);
}

async function expectBillingError(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof BillingError && error.code === code,
  );
}

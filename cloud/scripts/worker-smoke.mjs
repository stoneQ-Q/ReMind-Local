import assert from 'node:assert/strict';

import pg from 'pg';

process.loadEnvFile?.('.env');

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://${process.env.REMIND_POSTGRES_USER}:${process.env.REMIND_POSTGRES_PASSWORD}@127.0.0.1:${process.env.REMIND_DB_PORT}/${process.env.REMIND_POSTGRES_DB}`;
const pool = new pg.Pool({ connectionString: databaseUrl });
let userId;
let jobId;

try {
  const user = await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  userId = user.rows[0].id;
  await pool.query('INSERT INTO billing_accounts (user_id) VALUES ($1)', [userId]);
  const job = await pool.query(
    `INSERT INTO jobs (
       user_id, type, idempotency_key, input_json,
       max_attempts, timeout_seconds
     ) VALUES (
       $1, 'system.noop', 'worker-smoke', '{"source":"worker-smoke"}', 2, 10
     )
     RETURNING id`,
    [userId],
  );
  jobId = job.rows[0].id;

  const deadline = Date.now() + 10_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = (
      await pool.query(
        `SELECT status, attempt_count, result_json, input_json
         FROM jobs WHERE user_id = $1 AND id = $2`,
        [userId, jobId],
      )
    ).rows[0];
    if (snapshot?.status === 'succeeded') break;
    await wait(100);
  }
  assert.equal(snapshot?.status, 'succeeded');
  assert.equal(snapshot.attempt_count, 1);
  assert.deepEqual(snapshot.result_json, { ok: true });
  assert.deepEqual(snapshot.input_json, { source: 'worker-smoke' });

  const attempts = await pool.query(
    `SELECT attempt_number, status, error_code
     FROM job_attempts
     WHERE user_id = $1 AND job_id = $2`,
    [userId, jobId],
  );
  assert.equal(attempts.rowCount, 1);
  assert.equal(attempts.rows[0].attempt_number, 1);
  assert.equal(attempts.rows[0].status, 'succeeded');
  assert.equal(attempts.rows[0].error_code, null);
  console.log(
    'live worker smoke test passed: system.noop executed once with preserved input and attempt history',
  );
} finally {
  if (userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM job_attempts WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM jobs WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM worker_user_fairness WHERE user_id = $1', [
        userId,
      ]);
      await client.query('DELETE FROM billing_accounts WHERE user_id = $1', [
        userId,
      ]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

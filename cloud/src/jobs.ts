import type { Pool, PoolClient } from 'pg';

export type ClaimedJob = {
  id: string;
  userId: string;
  type: string;
  input: unknown;
  attemptCount: number;
};

type JobRow = {
  id: string;
  user_id: string;
  type: string;
  input_json: unknown;
  attempt_count: number;
};

export async function claimNextNoopJob(
  pool: Pool,
): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<JobRow>(`
      WITH candidate AS (
        SELECT id
        FROM jobs
        WHERE status = 'queued'
          AND type = 'system.noop'
          AND available_at <= now()
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs
      SET status = 'running',
          started_at = COALESCE(started_at, now()),
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = (SELECT id FROM candidate)
      RETURNING id, user_id, type, input_json, attempt_count
    `);
    await client.query('COMMIT');
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          type: row.type,
          input: row.input_json,
          attemptCount: row.attempt_count,
        }
      : null;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeNoopJob(
  pool: Pool,
  job: ClaimedJob,
): Promise<void> {
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'succeeded',
         result_json = $1::jsonb,
         actual_cost_micros = 0,
         finished_at = now(),
         updated_at = now()
     WHERE id = $2
       AND user_id = $3
       AND status = 'running'`,
    [JSON.stringify({ ok: true }), job.id, job.userId],
  );
  if (result.rowCount !== 1) {
    throw new Error('Claimed job ownership or status changed');
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original database error is more useful than a rollback failure.
  }
}

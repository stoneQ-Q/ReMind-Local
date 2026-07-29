import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDatabase, database } from './database.js';

const MIGRATION_LOCK_ID = 7_214_306_291;
const migrationsDirectory = process.env.REMIND_MIGRATIONS_DIRECTORY
  ? resolve(process.env.REMIND_MIGRATIONS_DIRECTORY)
  : fileURLToPath(new URL('../migrations/', import.meta.url).href);

await runMigrations();

async function runMigrations(): Promise<void> {
  const client = await database.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [
      MIGRATION_LOCK_ID,
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        sha256_hex TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const name of names) {
      const sql = await readFile(`${migrationsDirectory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query<{ sha256_hex: string }>(
        'SELECT sha256_hex FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].sha256_hex !== checksum) {
          throw new Error(`Applied migration checksum changed: ${name}`);
        }
        continue;
      }

      if (name === '0001_cloud_core.sql' && (await coreSchemaExists(client))) {
        await client.query(
          `INSERT INTO schema_migrations (name, sha256_hex)
           VALUES ($1, $2)`,
          [name, checksum],
        );
        console.log(`Baselined existing migration ${name}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (name, sha256_hex)
           VALUES ($1, $2)`,
          [name, checksum],
        );
        await client.query('COMMIT');
        console.log(`Applied migration ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [
      MIGRATION_LOCK_ID,
    ]);
    client.release();
    await closeDatabase();
  }
}

async function coreSchemaExists(
  client: import('pg').PoolClient,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(`
    SELECT (
      to_regclass('public.users') IS NOT NULL
      AND to_regclass('public.user_identities') IS NOT NULL
      AND to_regclass('public.user_sessions') IS NOT NULL
      AND to_regclass('public.devices') IS NOT NULL
      AND to_regclass('public.wechat_connections') IS NOT NULL
      AND to_regclass('public.notes') IS NOT NULL
      AND to_regclass('public.files') IS NOT NULL
      AND to_regclass('public.api_credentials') IS NOT NULL
      AND to_regclass('public.billing_accounts') IS NOT NULL
      AND to_regclass('public.jobs') IS NOT NULL
      AND to_regclass('public.ledger_entries') IS NOT NULL
    ) AS present
  `);
  return result.rows[0]?.present === true;
}

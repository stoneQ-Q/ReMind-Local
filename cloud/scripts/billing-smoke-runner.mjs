import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import pg from 'pg';

process.loadEnvFile?.('.env');

const configuredUrl =
  process.env.DATABASE_URL ??
  `postgresql://${encodeURIComponent(process.env.REMIND_POSTGRES_USER)}:${encodeURIComponent(process.env.REMIND_POSTGRES_PASSWORD)}@127.0.0.1:${encodeURIComponent(process.env.REMIND_DB_PORT ?? '5432')}/${encodeURIComponent(process.env.REMIND_POSTGRES_DB)}`;
const testDatabaseName = `remind_billing_test_${randomBytes(6).toString('hex')}`;
const adminUrl = withDatabase(configuredUrl, 'postgres');
const testUrl = withDatabase(configuredUrl, testDatabaseName);
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });

try {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
  await runNode(['dist/migrate.js'], {
    DATABASE_URL: testUrl,
    REMIND_MIGRATIONS_DIRECTORY: 'db/migrations',
  });
  await runNode(['scripts/billing-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/cost-controls-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/job-executor-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/wechat-polling-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/link-processing-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/object-storage-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/managed-media-api-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
  await runNode(['scripts/media-processing-smoke.mjs'], {
    REMIND_BILLING_TEST_DATABASE_URL: testUrl,
  });
} finally {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [testDatabaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)}`);
  await admin.end();
}

function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value) {
  if (!/^remind_billing_test_[a-f0-9]{12}$/.test(value)) {
    throw new Error('Refusing unsafe temporary database name');
  }
  return `"${value}"`;
}

function runNode(arguments_, extraEnvironment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnvironment },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Child process failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
          ),
        );
      }
    });
  });
}

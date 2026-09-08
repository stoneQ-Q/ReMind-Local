import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { Pool } from 'pg';

import { loadApiCredential } from './ai-settings.js';
import { creditBalance } from './billing.js';
import { loadCloudRuntimeConfig } from './config.js';
import { credentialCipherFromEnvironment } from './credential-cipher.js';

const CONFIRMATION = 'bootstrap-single-consumer';
const STARTER_CREDIT_MICROS = 2_000_000n;
const STARTER_YILI = 200;

export function upsertEnvironmentLines(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  const pending = new Map(Object.entries(values));
  const requested = new Set(pending.keys());
  const seen = new Set<string>();
  const lines = source.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match) return line;
    const key = match[1]!;
    if (requested.has(key) && seen.has(key)) {
      throw new Error(`Duplicate managed environment setting: ${key}`);
    }
    if (requested.has(key)) seen.add(key);
    const value = pending.get(key);
    if (value === undefined) return line;
    pending.delete(key);
    return `${key}=${safeEnvironmentValue(value)}`;
  });
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (const [key, value] of pending) {
    lines.push(`${key}=${safeEnvironmentValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function safeEnvironmentValue(value: string): string {
  if (!/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error('Operator value contains unsupported environment characters');
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.REMIND_OPERATOR_CONFIRM !== CONFIRMATION) {
    throw new Error('Explicit operator confirmation is required');
  }
  const envPath = process.env.REMIND_OPERATOR_ENV_PATH?.trim();
  if (!envPath || basename(envPath) !== 'remind.env') {
    throw new Error('REMIND_OPERATOR_ENV_PATH must target remind.env');
  }
  const envStat = await lstat(envPath);
  if (!envStat.isFile() || envStat.isSymbolicLink()) {
    throw new Error('Operator environment target must be a regular file');
  }

  const pool = new Pool({ connectionString: loadCloudRuntimeConfig().databaseUrl });
  try {
    const users = await pool.query<{ id: string; ai_mode: string }>(
      `SELECT id, ai_mode
       FROM users
       WHERE status = 'active'
       ORDER BY created_at ASC`,
    );
    if (users.rowCount !== 1 || !users.rows[0]) {
      throw new Error('Managed bootstrap requires exactly one active user');
    }
    const user = users.rows[0];
    const credentialCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM api_credentials
       WHERE user_id = $1
         AND provider = 'deepseek'
         AND revoked_at IS NULL`,
      [user.id],
    );
    if (credentialCount.rows[0]?.count !== '1') {
      throw new Error('Managed bootstrap requires exactly one DeepSeek credential');
    }
    const apiKey = await loadApiCredential(
      pool,
      credentialCipherFromEnvironment(),
      user.id,
      'deepseek',
    );
    if (!apiKey || !/^sk-[A-Za-z0-9_-]{10,256}$/.test(apiKey)) {
      throw new Error('Stored DeepSeek credential has an unexpected format');
    }

    const currentEnvironment = await readFile(envPath, 'utf8');
    const nextEnvironment = upsertEnvironmentLines(currentEnvironment, {
      REMIND_CONSUMER_MANAGED_AI_ENABLED: 'true',
      REMIND_CONSUMER_STARTER_CREDIT_MICROS:
        STARTER_CREDIT_MICROS.toString(),
      REMIND_MANAGED_DEEPSEEK_API_KEY: apiKey,
      REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS: '1000000',
      REMIND_PRICE_DEEPSEEK_OUTPUT_PER_MILLION_TOKENS_MICROS: '2000000',
    });
    const temporaryPath = join(
      dirname(envPath),
      `.remind.env.managed-${process.pid}.tmp`,
    );
    await writeFile(temporaryPath, nextEnvironment, { mode: 0o600 });
    await rename(temporaryPath, envPath);

    await pool.query(`UPDATE users SET ai_mode = 'managed' WHERE id = $1`, [
      user.id,
    ]);
    await creditBalance(
      pool,
      user.id,
      STARTER_CREDIT_MICROS,
      'operator:consumer-managed-trial-20260817',
      { source: 'gift', reason: 'consumer_managed_trial' },
    );
    console.log(
      `Managed consumer bootstrap completed for one account with ${STARTER_YILI} Yili`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('bootstrap-managed-consumer.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Managed bootstrap failed');
    process.exitCode = 1;
  });
}

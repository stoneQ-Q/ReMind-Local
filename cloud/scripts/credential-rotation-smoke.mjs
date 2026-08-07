import assert from 'node:assert/strict';

import pg from 'pg';

import {
  loadApiCredential,
  rotateApiCredentials,
} from '../dist/ai-settings.js';
import { LocalAesGcmCredentialCipher } from '../dist/credential-cipher.js';

process.loadEnvFile?.('.env');

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://${process.env.REMIND_POSTGRES_USER}:${process.env.REMIND_POSTGRES_PASSWORD}@127.0.0.1:${process.env.REMIND_DB_PORT}/${process.env.REMIND_POSTGRES_DB}`;
const apiBaseUrl = process.env.REMIND_CLOUD_API_URL ?? 'http://127.0.0.1:8790';
const pool = new pg.Pool({ connectionString: databaseUrl });
let userId;

try {
  const registration = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'unknown',
      displayName: '密钥轮换测试',
      appVersion: '0.0.0-rotation-test',
    }),
  });
  assert.equal(registration.status, 201);
  const account = await registration.json();
  userId = account.userId;

  const apiKey = 'test-rotation-key-not-a-real-secret-6621';
  const saved = await fetch(
    `${apiBaseUrl}/api/v1/ai/credentials/deepseek`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey }),
    },
  );
  assert.equal(saved.status, 200);

  const currentVersion = process.env.REMIND_CREDENTIAL_KEY_VERSION;
  const currentKey = Buffer.from(
    process.env.REMIND_CREDENTIAL_KEY_BASE64,
    'base64',
  );
  const rotatingCipher = new LocalAesGcmCredentialCipher(
    'rotation-test-v2',
    new Map([
      [currentVersion, currentKey],
      ['rotation-test-v2', Buffer.alloc(32, 9)],
    ]),
  );
  assert.equal(await rotateApiCredentials(pool, rotatingCipher), 1);

  const stored = await pool.query(
    `SELECT encryption_key_version
     FROM api_credentials
     WHERE user_id = $1 AND provider = 'deepseek'`,
    [userId],
  );
  assert.equal(stored.rows[0].encryption_key_version, 'rotation-test-v2');
  assert.equal(
    await loadApiCredential(pool, rotatingCipher, userId, 'deepseek'),
    apiKey,
  );
  console.log('credential rotation smoke test passed');
} finally {
  if (userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

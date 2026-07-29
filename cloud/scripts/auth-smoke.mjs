import assert from 'node:assert/strict';

import pg from 'pg';

process.loadEnvFile?.('.env');

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://${process.env.REMIND_POSTGRES_USER}:${process.env.REMIND_POSTGRES_PASSWORD}@127.0.0.1:${process.env.REMIND_DB_PORT}/${process.env.REMIND_POSTGRES_DB}`;
const apiBaseUrl = process.env.REMIND_CLOUD_API_URL ?? 'http://127.0.0.1:8790';
const pool = new pg.Pool({ connectionString: databaseUrl });
const createdUserIds = [];

try {
  const first = await register('第一台测试设备');
  const second = await register('第二位用户设备');
  createdUserIds.push(first.userId, second.userId);

  assert.notEqual(first.userId, second.userId);
  assert.notEqual(first.recoveryCode, second.recoveryCode);

  const firstProfile = await authenticatedJson(
    '/api/v1/users/me',
    first.accessToken,
  );
  const secondProfile = await authenticatedJson(
    '/api/v1/users/me',
    second.accessToken,
  );
  assert.equal(firstProfile.id, first.userId);
  assert.equal(secondProfile.id, second.userId);

  const recovered = await requestJson('/api/v1/auth/recover', {
    recoveryCode: first.recoveryCode.toLowerCase().replaceAll('-', ' '),
    platform: 'ios',
    displayName: '恢复后的测试设备',
    appVersion: '0.0.0-test',
  });
  assert.equal(recovered.status, 201);
  assert.equal(recovered.body.userId, first.userId);
  assert.notEqual(recovered.body.deviceId, first.deviceId);

  const firstDevices = await authenticatedJson(
    '/api/v1/devices',
    recovered.body.accessToken,
  );
  const secondDevices = await authenticatedJson(
    '/api/v1/devices',
    second.accessToken,
  );
  assert.equal(firstDevices.devices.length, 2);
  assert.equal(secondDevices.devices.length, 1);
  assert.ok(
    firstDevices.devices.every(
      (device) =>
        device.id === first.deviceId || device.id === recovered.body.deviceId,
    ),
  );
  assert.ok(
    secondDevices.devices.every((device) => device.id === second.deviceId),
  );

  const invalidRecovery = await requestJson('/api/v1/auth/recover', {
    recoveryCode: 'RM-INVALID-CODE',
    platform: 'android',
  });
  assert.equal(invalidRecovery.status, 401);

  const storedSecrets = await pool.query(
    `SELECT
       (SELECT bool_and(char_length(secret_hash) = 64)
        FROM recovery_credentials
        WHERE user_id = ANY($1::uuid[])) AS recovery_hashed,
       (SELECT bool_and(char_length(token_hash) = 64)
        FROM user_sessions
        WHERE user_id = ANY($1::uuid[])) AS sessions_hashed,
       (SELECT bool_and(char_length(secret_hash) = 64)
        FROM devices
        WHERE user_id = ANY($1::uuid[])) AS devices_hashed`,
    [createdUserIds],
  );
  assert.equal(storedSecrets.rows[0].recovery_hashed, true);
  assert.equal(storedSecrets.rows[0].sessions_hashed, true);
  assert.equal(storedSecrets.rows[0].devices_hashed, true);

  console.log(
    'anonymous auth smoke test passed: registration, recovery, sessions, and two-user isolation',
  );
} finally {
  if (createdUserIds.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM billing_accounts
         WHERE user_id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1
             FROM ledger_entries
             WHERE ledger_entries.billing_account_id = billing_accounts.id
           )`,
        [createdUserIds],
      );
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        createdUserIds,
      ]);
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

async function register(displayName) {
  const result = await requestJson('/api/v1/auth/register', {
    platform: 'android',
    displayName,
    appVersion: '0.0.0-test',
  });
  assert.equal(result.status, 201);
  return result.body;
}

async function authenticatedJson(path, accessToken) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function requestJson(path, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

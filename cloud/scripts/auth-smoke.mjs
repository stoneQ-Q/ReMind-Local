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

  const refreshed = await requestJson('/api/v1/auth/refresh', {
    deviceId: first.deviceId,
    deviceSecret: first.deviceSecret,
  });
  assert.equal(refreshed.status, 201);
  assert.equal(refreshed.body.userId, first.userId);
  assert.equal(refreshed.body.deviceId, first.deviceId);
  assert.notEqual(refreshed.body.accessToken, first.accessToken);

  const oldSession = await fetch(`${apiBaseUrl}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${first.accessToken}` },
  });
  assert.equal(oldSession.status, 401);
  const refreshedProfile = await authenticatedJson(
    '/api/v1/users/me',
    refreshed.body.accessToken,
  );
  assert.equal(refreshedProfile.id, first.userId);
  const invalidRefresh = await requestJson('/api/v1/auth/refresh', {
    deviceId: first.deviceId,
    deviceSecret: 'rmd_invalid',
  });
  assert.equal(invalidRefresh.status, 401);

  const testApiKey = 'test-provider-key-not-a-real-secret-8472';
  const initialAiSettings = await authenticatedRequest(
    'GET',
    '/api/v1/ai/settings',
    refreshed.body.accessToken,
  );
  assert.equal(initialAiSettings.status, 200);
  assert.equal(initialAiSettings.body.mode, 'disabled');
  assert.deepEqual(initialAiSettings.body.credentials, []);

  const missingCredentialMode = await authenticatedRequest(
    'PUT',
    '/api/v1/ai/settings',
    refreshed.body.accessToken,
    { mode: 'bring_your_own_key' },
  );
  assert.equal(missingCredentialMode.status, 409);

  const savedCredential = await authenticatedRequest(
    'PUT',
    '/api/v1/ai/credentials/deepseek',
    refreshed.body.accessToken,
    { apiKey: testApiKey },
  );
  assert.equal(savedCredential.status, 200);
  assert.equal(savedCredential.body.credentials.length, 1);
  assert.equal(savedCredential.body.credentials[0].maskedSuffix, '8472');
  assert.equal(JSON.stringify(savedCredential.body).includes(testApiKey), false);

  const zhipuApiKey = 'test-zhipu-key-not-a-real-secret-9911';
  const secondCredential = await authenticatedRequest(
    'PUT',
    '/api/v1/ai/credentials/zhipu',
    refreshed.body.accessToken,
    { apiKey: zhipuApiKey },
  );
  assert.equal(secondCredential.status, 200);
  assert.equal(secondCredential.body.credentials.length, 2);
  assert.equal(JSON.stringify(secondCredential.body).includes(zhipuApiKey), false);

  const encryptedAtRest = await pool.query(
    `SELECT
       bool_and(
         position(convert_to($2, 'UTF8') in encrypted_key) = 0
         AND position(convert_to($3, 'UTF8') in encrypted_key) = 0
       ) AS plaintext_absent,
       encryption_key_version
     FROM api_credentials
     WHERE user_id = $1
     GROUP BY encryption_key_version`,
    [first.userId, testApiKey, zhipuApiKey],
  );
  assert.equal(encryptedAtRest.rows[0].plaintext_absent, true);
  assert.equal(encryptedAtRest.rows[0].encryption_key_version, 'local-v1');

  const secondUserAiSettings = await authenticatedRequest(
    'GET',
    '/api/v1/ai/settings',
    second.accessToken,
  );
  assert.equal(secondUserAiSettings.status, 200);
  assert.deepEqual(secondUserAiSettings.body.credentials, []);

  const ownKeyMode = await authenticatedRequest(
    'PUT',
    '/api/v1/ai/settings',
    refreshed.body.accessToken,
    { mode: 'bring_your_own_key' },
  );
  assert.equal(ownKeyMode.status, 200);
  assert.equal(ownKeyMode.body.mode, 'bring_your_own_key');

  const managedMode = await authenticatedRequest(
    'PUT',
    '/api/v1/ai/settings',
    refreshed.body.accessToken,
    { mode: 'managed' },
  );
  assert.equal(managedMode.status, 200);
  assert.equal(managedMode.body.mode, 'managed');

  await authenticatedRequest(
    'PUT',
    '/api/v1/ai/settings',
    refreshed.body.accessToken,
    { mode: 'bring_your_own_key' },
  );
  const deletedCredential = await authenticatedRequest(
    'DELETE',
    '/api/v1/ai/credentials/deepseek',
    refreshed.body.accessToken,
  );
  assert.equal(deletedCredential.status, 200);
  assert.equal(deletedCredential.body.mode, 'bring_your_own_key');
  assert.equal(deletedCredential.body.credentials.length, 1);
  assert.equal(deletedCredential.body.credentials[0].provider, 'zhipu');
  const deletedLastCredential = await authenticatedRequest(
    'DELETE',
    '/api/v1/ai/credentials/zhipu',
    refreshed.body.accessToken,
  );
  assert.equal(deletedLastCredential.status, 200);
  assert.equal(deletedLastCredential.body.mode, 'disabled');
  assert.deepEqual(deletedLastCredential.body.credentials, []);

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
    'cloud smoke test passed: auth, renewal, recovery, AI settings, encrypted credentials, and two-user isolation',
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
  const result = await authenticatedRequest('GET', path, accessToken);
  assert.equal(result.status, 200);
  return result.body;
}

async function authenticatedRequest(method, path, accessToken, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
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

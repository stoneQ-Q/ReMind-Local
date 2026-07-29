import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import pg from 'pg';

import { creditBalance } from '../dist/billing.js';
import { ensureNextMediaProcessingJob } from '../dist/media-processing.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const port = 18_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const pool = new pg.Pool({ connectionString: databaseUrl });
const api = spawn(process.execPath, ['dist/api.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    REMIND_CREDENTIAL_KEY_VERSION: 'api-smoke-v1',
    REMIND_CREDENTIAL_KEY_BASE64: randomBytes(32).toString('base64'),
    REMIND_MEDIA_PROVIDER: 'remote',
    REMIND_PRICE_ZHIPU_VISION_PER_IMAGE_MICROS: '1200000',
    REMIND_PRICE_ZHIPU_ASR_PER_MINUTE_MICROS: '1200000',
    REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS: '2000000',
    REMIND_PRICE_DEEPSEEK_OUTPUT_PER_MILLION_TOKENS_MICROS: '4000000',
  },
});
let apiErrors = '';
api.stderr.setEncoding('utf8');
api.stderr.on('data', (chunk) => {
  apiErrors = (apiErrors + chunk).slice(-4_000);
});

try {
  await waitUntilReady();
  const registration = await jsonRequest('POST', '/api/v1/auth/register', null, {
    platform: 'android',
    displayName: '托管媒体 API 测试',
    appVersion: '0.0.0-test',
  });
  assert.equal(registration.status, 201);
  const userId = registration.body.userId;
  const token = registration.body.accessToken;
  const settings = await jsonRequest(
    'PUT',
    '/api/v1/ai/settings',
    token,
    { mode: 'managed' },
  );
  assert.equal(settings.status, 200);
  await creditBalance(pool, userId, 5_000_000n, 'managed-api-credit');

  const image = await insertSourceFile(userId, 'image', 'image/png');
  const audio = await insertSourceFile(userId, 'audio', 'audio/mpeg');
  const created = await jsonRequest(
    'POST',
    '/api/v1/media/requests',
    token,
    {
      sourceFileId: image,
      idempotencyKey: 'managed-api-image',
    },
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.request.status, 'awaiting_confirmation');
  assert.equal(created.body.request.executionMode, 'managed');
  assert.equal(created.body.quote.type, 'media.pipeline');
  assert.equal(created.body.quote.confirmationRequired, true);

  const confirmed = await jsonRequest(
    'POST',
    `/api/v1/jobs/${created.body.quote.jobId}/confirm`,
    token,
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.quote.status, 'reserved');
  assert.equal(confirmed.body.account.reservedMicros, '1200000');

  const fetched = await jsonRequest(
    'GET',
    `/api/v1/media/requests/${created.body.request.id}`,
    token,
  );
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.billingJobId, created.body.quote.jobId);

  const missingDuration = await jsonRequest(
    'POST',
    '/api/v1/media/requests',
    token,
    {
      sourceFileId: audio,
      idempotencyKey: 'managed-api-audio-missing-duration',
    },
  );
  assert.equal(missingDuration.status, 400);
  assert.equal(missingDuration.body.error, 'invalid_media_duration');

  const cancellation = await jsonRequest(
    'POST',
    `/api/v1/media/requests/${created.body.request.id}/cancel`,
    token,
  );
  assert.equal(cancellation.status, 202);
  assert.equal(cancellation.body.status, 'releasing');
  assert.match(await ensureNextMediaProcessingJob(pool), /^finalized:/);

  console.log(
    'managed media API smoke test passed: remote-mode quote creation, one confirmation/reservation, request lookup, and duration validation without platform keys in the API process',
  );
} finally {
  if (api.exitCode === null) {
    api.kill('SIGTERM');
    await new Promise((resolve) => api.once('exit', resolve));
  }
  await pool.end();
}

async function insertSourceFile(ownerId, mediaKind, contentType) {
  const result = await pool.query(
    `INSERT INTO files (
       user_id, object_key, content_type, size_bytes, sha256_hex,
       purpose, media_kind, status
     ) VALUES (
       $1::uuid,
       'users/' || ($1::uuid)::text || '/source/' || gen_random_uuid()::text,
       $2, 1, repeat('a', 64), 'source', $3, 'ready'
     )
     RETURNING id`,
    [ownerId, contentType, mediaKind],
  );
  return result.rows[0].id;
}

async function jsonRequest(method, path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (api.exitCode !== null) {
      throw new Error(`managed media API exited early: ${apiErrors}`);
    }
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
    } catch {
      // API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`managed media API did not become ready: ${apiErrors}`);
}

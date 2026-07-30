import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { creditBalance } from '../dist/billing.js';
import { ensureNextMediaProcessingJob } from '../dist/media-processing.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const port = 18_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const pool = new pg.Pool({ connectionString: databaseUrl });
const objectDirectory = await mkdtemp(join(tmpdir(), 'remind-upload-api-'));
const api = spawn(process.execPath, ['dist/api.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    REMIND_CREDENTIAL_KEY_VERSION: 'api-smoke-v1',
    REMIND_CREDENTIAL_KEY_BASE64: randomBytes(32).toString('base64'),
    REMIND_MEDIA_PROVIDER: 'remote',
    REMIND_OBJECT_STORE_ROOT: objectDirectory,
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
  const otherRegistration = await jsonRequest(
    'POST',
    '/api/v1/auth/register',
    null,
    {
      platform: 'ios',
      displayName: '其他上传用户',
      appVersion: '0.0.0-test',
    },
  );
  const settings = await jsonRequest(
    'PUT',
    '/api/v1/ai/settings',
    token,
    { mode: 'managed' },
  );
  assert.equal(settings.status, 200);
  await creditBalance(pool, userId, 5_000_000n, 'managed-api-credit');

  const imageContent = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('private image uploaded through API'),
  ]);
  const imageDigest = createHash('sha256')
    .update(imageContent)
    .digest('hex');
  const imageUpload = await jsonRequest(
    'POST',
    '/api/v1/files/uploads',
    token,
    {
      contentType: 'image/png',
      sizeBytes: imageContent.length,
      sha256Hex: imageDigest,
      idempotencyKey: 'managed-api-image-upload',
      originalName: '../private/image.png',
    },
  );
  assert.equal(imageUpload.status, 201);
  assert.equal(imageUpload.body.status, 'pending');
  const otherUsersUpload = await jsonRequest(
    'GET',
    `/api/v1/files/uploads/${imageUpload.body.id}`,
    otherRegistration.body.accessToken,
  );
  assert.equal(otherUsersUpload.status, 404);
  const firstChunk = imageContent.subarray(0, 12);
  const firstChunkResult = await uploadChunk(
    imageUpload.body.id,
    token,
    0,
    firstChunk,
  );
  assert.equal(firstChunkResult.status, 200);
  assert.equal(firstChunkResult.body.uploadedSizeBytes, firstChunk.length);
  const wrongOffset = await uploadChunk(
    imageUpload.body.id,
    token,
    0,
    imageContent.subarray(12),
  );
  assert.equal(wrongOffset.status, 409);
  assert.equal(wrongOffset.body.error, 'upload_offset_mismatch');
  const secondChunkResult = await uploadChunk(
    imageUpload.body.id,
    token,
    firstChunk.length,
    imageContent.subarray(firstChunk.length),
  );
  assert.equal(secondChunkResult.status, 200);
  const completedUpload = await jsonRequest(
    'POST',
    `/api/v1/files/uploads/${imageUpload.body.id}/complete`,
    token,
  );
  assert.equal(completedUpload.status, 200);
  assert.equal(completedUpload.body.status, 'succeeded');
  const image = completedUpload.body.fileId;
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

  const listed = await jsonRequest(
    'GET',
    '/api/v1/media/requests',
    token,
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].request.id, created.body.request.id);
  assert.equal(listed.body.items[0].quote.jobId, created.body.quote.jobId);
  assert.equal(listed.body.items[0].currentJob, null);
  const otherUsersList = await jsonRequest(
    'GET',
    '/api/v1/media/requests',
    otherRegistration.body.accessToken,
  );
  assert.equal(otherUsersList.status, 200);
  assert.deepEqual(otherUsersList.body.items, []);

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
    'managed media API smoke test passed: tenant-isolated resumable upload, task listing, offset recovery, integrity completion, remote-mode quote creation, one confirmation/reservation, request lookup, and duration validation without platform keys in the API process',
  );
} finally {
  if (api.exitCode === null) {
    api.kill('SIGTERM');
    await new Promise((resolve) => api.once('exit', resolve));
  }
  await pool.end();
  await rm(objectDirectory, { recursive: true, force: true });
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

async function uploadChunk(uploadId, token, offset, content) {
  const response = await fetch(
    `${baseUrl}/api/v1/files/uploads/${uploadId}/chunks`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Upload-Offset': String(offset),
      },
      body: content,
    },
  );
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

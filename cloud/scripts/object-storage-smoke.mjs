import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import {
  cleanupNextExpiredObject,
  readUserObjectFile,
  saveObjectFile,
} from '../dist/object-files.js';
import { LocalFilesystemObjectStore } from '../dist/object-store.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });
const directory = await mkdtemp(join(tmpdir(), 'remind-object-smoke-'));
const store = new LocalFilesystemObjectStore(directory);

try {
  const firstUser = await createUser();
  const secondUser = await createUser();
  const first = await saveObjectFile(pool, store, {
    userId: firstUser,
    contentType: 'audio/mpeg',
    content: Buffer.from('first user temporary audio'),
    purpose: 'temporary',
    originalName: '../private/audio.mp3',
    temporaryTtlSeconds: 300,
  });
  const second = await saveObjectFile(pool, store, {
    userId: secondUser,
    contentType: 'image/png; charset=binary',
    content: Buffer.from('second user temporary image'),
    purpose: 'temporary',
    temporaryTtlSeconds: 300,
  });
  const retained = await saveObjectFile(pool, store, {
    userId: firstUser,
    contentType: 'video/mp4',
    content: Buffer.from('retained source video'),
    purpose: 'source',
    originalName: 'source-video.mp4',
  });

  assert.equal(
    (await readUserObjectFile(pool, store, firstUser, first.id)).toString(),
    'first user temporary audio',
  );
  await assert.rejects(
    readUserObjectFile(pool, store, firstUser, second.id),
    /file_not_found/,
  );
  assert.equal(first.expiresAt !== null, true);
  assert.equal(retained.expiresAt, null);

  const metadata = await pool.query(
    `SELECT id, user_id, object_key, content_type, size_bytes, sha256_hex,
            purpose, media_kind, status, original_name
     FROM files WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[first.id, second.id, retained.id]],
  );
  assert.equal(metadata.rowCount, 3);
  assert.equal(
    metadata.rows.every((row) =>
      row.object_key.startsWith(`users/${row.user_id}/`),
    ),
    true,
  );
  assert.equal(
    metadata.rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256_hex)),
    true,
  );
  assert.equal(
    metadata.rows.find((row) => row.id === first.id).original_name,
    '.._private_audio.mp3',
  );
  assert.equal(
    JSON.stringify(metadata.rows).includes('first user temporary audio'),
    false,
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO files (
         user_id, object_key, content_type, size_bytes, sha256_hex,
         purpose, media_kind, status, expires_at
       ) VALUES (
         $1, $2, 'image/png', 1, $3,
         'temporary', 'image', 'ready', now()
       )`,
      [
        firstUser,
        `users/${secondUser}/temporary/00000000-0000-4000-8000-000000000001.png`,
        'a'.repeat(64),
      ],
    ),
    /files_tenant_object_key/,
  );

  await pool.query(
    `UPDATE files SET expires_at = now() - interval '1 second'
     WHERE id = ANY($1::uuid[])`,
    [[first.id, second.id, retained.id]],
  );
  const cleanupResults = await Promise.all([
    cleanupNextExpiredObject(pool, store),
    cleanupNextExpiredObject(pool, store),
  ]);
  assert.deepEqual(
    cleanupResults.map((result) => result?.deleted).sort(),
    [true, true],
  );
  assert.equal(await cleanupNextExpiredObject(pool, store), null);
  const afterCleanup = await pool.query(
    `SELECT id, status, deleted_at
     FROM files WHERE id = ANY($1::uuid[])`,
    [[first.id, second.id, retained.id]],
  );
  assert.equal(
    afterCleanup.rows.filter((row) => row.status === 'deleted').length,
    2,
  );
  assert.equal(
    afterCleanup.rows.find((row) => row.id === retained.id).status,
    'ready',
  );

  const retryFile = await saveObjectFile(pool, store, {
    userId: firstUser,
    contentType: 'audio/mpeg',
    content: Buffer.from('retry cleanup audio'),
    purpose: 'temporary',
    temporaryTtlSeconds: 300,
  });
  await pool.query(
    `UPDATE files SET expires_at = now() - interval '1 second'
     WHERE user_id = $1 AND id = $2`,
    [firstUser, retryFile.id],
  );
  let failOnce = true;
  const flakyStore = {
    ...store,
    provider: store.provider,
    put: store.put.bind(store),
    read: store.read.bind(store),
    copyToFile: store.copyToFile.bind(store),
    async delete(key) {
      if (failOnce) {
        failOnce = false;
        throw new Error('temporary_delete_failure');
      }
      await store.delete(key);
    },
  };
  assert.deepEqual(await cleanupNextExpiredObject(pool, flakyStore), {
    fileId: retryFile.id,
    deleted: false,
  });
  const failedAttempt = await pool.query(
    `SELECT status, last_error_code, deletion_attempt_count,
            cleanup_lease_expires_at
     FROM files WHERE user_id = $1 AND id = $2`,
    [firstUser, retryFile.id],
  );
  assert.equal(failedAttempt.rows[0].status, 'deleting');
  assert.equal(failedAttempt.rows[0].last_error_code, 'temporary_delete_failure');
  assert.equal(failedAttempt.rows[0].deletion_attempt_count, 1);

  await pool.query(
    `UPDATE files
     SET cleanup_lease_expires_at = now() - interval '1 second'
     WHERE user_id = $1 AND id = $2`,
    [firstUser, retryFile.id],
  );
  assert.deepEqual(await cleanupNextExpiredObject(pool, flakyStore), {
    fileId: retryFile.id,
    deleted: true,
  });
  const attempts = await pool.query(
    `SELECT attempt_number, status, error_code
     FROM file_deletion_attempts
     WHERE user_id = $1 AND file_id = $2
     ORDER BY attempt_number`,
    [firstUser, retryFile.id],
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.status),
    ['failed', 'succeeded'],
  );

  const leaseFile = await saveObjectFile(pool, store, {
    userId: secondUser,
    contentType: 'image/jpeg',
    content: Buffer.from('cleanup lease recovery image'),
    purpose: 'temporary',
    temporaryTtlSeconds: 300,
  });
  const expiredLease = randomUUID();
  await pool.query(
    `UPDATE files
     SET status = 'deleting',
         deletion_attempt_count = 1,
         cleanup_lease_token = $1,
         cleanup_lease_expires_at = now() - interval '1 second'
     WHERE user_id = $2 AND id = $3`,
    [expiredLease, secondUser, leaseFile.id],
  );
  await pool.query(
    `INSERT INTO file_deletion_attempts (
       user_id, file_id, attempt_number, lease_token, status
     ) VALUES ($1, $2, 1, $3, 'running')`,
    [secondUser, leaseFile.id, expiredLease],
  );
  assert.deepEqual(await cleanupNextExpiredObject(pool, store), {
    fileId: leaseFile.id,
    deleted: true,
  });
  const recoveredAttempts = await pool.query(
    `SELECT attempt_number, status, error_code
     FROM file_deletion_attempts
     WHERE user_id = $1 AND file_id = $2
     ORDER BY attempt_number`,
    [secondUser, leaseFile.id],
  );
  assert.deepEqual(
    recoveredAttempts.rows.map((row) => [
      row.attempt_number,
      row.status,
      row.error_code,
    ]),
    [
      [1, 'failed', 'cleanup_lease_expired'],
      [2, 'succeeded', null],
    ],
  );

  const abandonedFileId = randomUUID();
  await pool.query(
    `INSERT INTO files (
       id, user_id, object_key, content_type, size_bytes, sha256_hex,
       purpose, media_kind, status, created_at
     ) VALUES (
       $1, $2, $3, 'video/mp4', 10, $4,
       'source', 'video', 'pending', now() - interval '11 minutes'
     )`,
    [
      abandonedFileId,
      firstUser,
      `users/${firstUser}/source/${abandonedFileId}.mp4`,
      'b'.repeat(64),
    ],
  );
  assert.deepEqual(await cleanupNextExpiredObject(pool, store), {
    fileId: abandonedFileId,
    deleted: true,
  });
  const abandoned = await pool.query(
    `SELECT status, deleted_at FROM files
     WHERE user_id = $1 AND id = $2`,
    [firstUser, abandonedFileId],
  );
  assert.equal(abandoned.rows[0].status, 'deleted');
  assert.ok(abandoned.rows[0].deleted_at);

  console.log(
    'object storage smoke test passed: tenant keys, metadata-only database records, integrity checks, cross-user isolation, concurrent expiry cleanup, source retention, retry, lease recovery, crash-orphan cleanup, and durable deletion history',
  );
} finally {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}

async function createUser() {
  const user = await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = user.rows[0].id;
  await pool.query('INSERT INTO billing_accounts (user_id) VALUES ($1)', [userId]);
  return userId;
}

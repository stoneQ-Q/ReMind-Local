import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import {
  appendFileUploadChunk,
  cancelFileUpload,
  cleanupNextExpiredFileUpload,
  completeFileUpload,
  createFileUpload,
  FileUploadError,
  getUserFileUpload,
} from '../dist/file-uploads.js';
import {
  cleanupNextExpiredObject,
  readUserObjectFile,
} from '../dist/object-files.js';
import { LocalFilesystemObjectStore } from '../dist/object-store.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });
const directory = await mkdtemp(join(tmpdir(), 'remind-upload-smoke-'));
const store = new LocalFilesystemObjectStore(directory);

try {
  const firstUser = await createUser();
  const secondUser = await createUser();
  const content = Buffer.concat([
    Buffer.from([0, 0, 0, 16]),
    Buffer.from('ftypisomprivate resumable video bytes'),
  ]);
  const digest = sha256(content);
  const upload = await createFileUpload(pool, store, {
    userId: firstUser,
    idempotencyKey: 'resumable-video',
    contentType: 'video/mp4',
    sizeBytes: content.length,
    sha256Hex: digest,
    originalName: '../private/video.mp4',
  });
  assert.equal(upload.status, 'pending');
  assert.equal(upload.strategy, 'proxy_chunks');
  assert.equal(upload.uploadedSizeBytes, 0);
  assert.equal(upload.originalName, '.._private_video.mp4');
  assert.equal(
    (
      await createFileUpload(pool, store, {
        userId: firstUser,
        idempotencyKey: 'resumable-video',
        contentType: 'video/mp4',
        sizeBytes: content.length,
        sha256Hex: digest,
        originalName: '../private/video.mp4',
      })
    ).id,
    upload.id,
  );
  await assert.rejects(
    createFileUpload(pool, store, {
      userId: firstUser,
      idempotencyKey: 'resumable-video',
      contentType: 'video/mp4',
      sizeBytes: content.length + 1,
      sha256Hex: digest,
    }),
    (error) =>
      error instanceof FileUploadError &&
      error.code === 'upload_idempotency_conflict',
  );
  assert.equal(
    await getUserFileUpload(pool, secondUser, upload.id),
    null,
  );
  await assert.rejects(
    appendFileUploadChunk(pool, store, {
      userId: secondUser,
      uploadId: upload.id,
      offset: 0,
      content,
    }),
    (error) =>
      error instanceof FileUploadError && error.code === 'upload_not_found',
  );

  const split = 10;
  const firstChunk = await appendFileUploadChunk(pool, store, {
    userId: firstUser,
    uploadId: upload.id,
    offset: 0,
    content: content.subarray(0, split),
  });
  assert.equal(firstChunk.uploadedSizeBytes, split);
  const concurrent = await Promise.allSettled([
    appendFileUploadChunk(pool, store, {
      userId: firstUser,
      uploadId: upload.id,
      offset: split,
      content: content.subarray(split),
    }),
    appendFileUploadChunk(pool, store, {
      userId: firstUser,
      uploadId: upload.id,
      offset: split,
      content: content.subarray(split),
    }),
  ]);
  assert.equal(
    concurrent.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    concurrent.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof FileUploadError &&
        result.reason.code === 'upload_offset_mismatch',
    ).length,
    1,
  );
  const completed = await completeFileUpload(
    pool,
    store,
    firstUser,
    upload.id,
  );
  assert.equal(completed.status, 'succeeded');
  assert.equal(
    (
      await completeFileUpload(pool, store, firstUser, upload.id)
    ).status,
    'succeeded',
  );
  assert.equal(
    (
      await readUserObjectFile(pool, store, firstUser, upload.fileId)
    ).toString(),
    content.toString(),
  );
  await assert.rejects(
    cancelFileUpload(pool, store, firstUser, upload.id),
    (error) =>
      error instanceof FileUploadError &&
      error.code === 'upload_already_completed',
  );

  const crashContent = Buffer.from('ID3completion crash recovery');
  const crashUpload = await createFileUpload(pool, store, {
    userId: firstUser,
    idempotencyKey: 'completion-crash',
    contentType: 'audio/mpeg',
    sizeBytes: crashContent.length,
    sha256Hex: sha256(crashContent),
  });
  await appendFileUploadChunk(pool, store, {
    userId: firstUser,
    uploadId: crashUpload.id,
    offset: 0,
    content: crashContent,
  });
  const crashRow = (
    await pool.query(
      `SELECT file.object_key
       FROM file_uploads AS upload
       JOIN files AS file
         ON file.user_id = upload.user_id AND file.id = upload.file_id
       WHERE upload.user_id = $1 AND upload.id = $2`,
      [firstUser, crashUpload.id],
    )
  ).rows[0];
  await store.completeUpload(
    crashUpload.id,
    crashRow.object_key,
    crashContent.length,
    sha256(crashContent),
  );
  assert.equal(
    (
      await completeFileUpload(pool, store, firstUser, crashUpload.id)
    ).status,
    'succeeded',
  );

  const cancelledContent = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('cancel this upload'),
  ]);
  const cancelled = await createFileUpload(pool, store, {
    userId: secondUser,
    idempotencyKey: 'cancel-upload',
    contentType: 'image/png',
    sizeBytes: cancelledContent.length,
    sha256Hex: sha256(cancelledContent),
  });
  await appendFileUploadChunk(pool, store, {
    userId: secondUser,
    uploadId: cancelled.id,
    offset: 0,
    content: cancelledContent.subarray(0, 5),
  });
  assert.equal(
    (
      await cancelFileUpload(pool, store, secondUser, cancelled.id)
    ).status,
    'cancelled',
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT status, deleted_at IS NOT NULL AS deleted
         FROM files WHERE user_id = $1 AND id = $2`,
        [secondUser, cancelled.fileId],
      )
    ).rows[0],
    { status: 'deleted', deleted: true },
  );

  const wrong = Buffer.from('ID3wrong digest bytes');
  const integrity = await createFileUpload(pool, store, {
    userId: firstUser,
    idempotencyKey: 'integrity-failure',
    contentType: 'audio/mpeg',
    sizeBytes: wrong.length,
    sha256Hex: sha256(Buffer.from('right digest byte')),
  });
  await appendFileUploadChunk(pool, store, {
    userId: firstUser,
    uploadId: integrity.id,
    offset: 0,
    content: wrong,
  });
  await assert.rejects(
    completeFileUpload(pool, store, firstUser, integrity.id),
    /upload_integrity_mismatch/,
  );
  assert.equal(
    (
      await getUserFileUpload(pool, firstUser, integrity.id)
    ).status,
    'failed',
  );

  const spoofed = Buffer.from('not really an mp3');
  const spoofedUpload = await createFileUpload(pool, store, {
    userId: firstUser,
    idempotencyKey: 'content-type-spoof',
    contentType: 'audio/mpeg',
    sizeBytes: spoofed.length,
    sha256Hex: sha256(spoofed),
  });
  await appendFileUploadChunk(pool, store, {
    userId: firstUser,
    uploadId: spoofedUpload.id,
    offset: 0,
    content: spoofed,
  });
  await assert.rejects(
    completeFileUpload(pool, store, firstUser, spoofedUpload.id),
    (error) =>
      error instanceof FileUploadError &&
      error.code === 'upload_content_type_mismatch',
  );

  const expiredContent = Buffer.from('ID3expired interrupted upload');
  const expired = await createFileUpload(pool, store, {
    userId: secondUser,
    idempotencyKey: 'expired-upload',
    contentType: 'audio/mpeg',
    sizeBytes: expiredContent.length,
    sha256Hex: sha256(expiredContent),
  });
  await appendFileUploadChunk(pool, store, {
    userId: secondUser,
    uploadId: expired.id,
    offset: 0,
    content: expiredContent.subarray(0, 4),
  });
  await pool.query(
    `UPDATE file_uploads
     SET expires_at = now() - interval '1 second',
         created_at = now() - interval '11 minutes'
     WHERE user_id = $1 AND id = $2`,
    [secondUser, expired.id],
  );
  await pool.query(
    `UPDATE files SET created_at = now() - interval '11 minutes'
     WHERE user_id = $1 AND id = $2`,
    [secondUser, expired.fileId],
  );
  assert.equal(await cleanupNextExpiredObject(pool, store), null);
  assert.deepEqual(await cleanupNextExpiredFileUpload(pool, store), {
    uploadId: expired.id,
    cleaned: true,
  });
  assert.equal(
    (
      await getUserFileUpload(pool, secondUser, expired.id)
    ).status,
    'cancelled',
  );

  const retryContent = Buffer.from('ID3cleanup retry upload');
  const retry = await createFileUpload(pool, store, {
    userId: firstUser,
    idempotencyKey: 'cleanup-retry',
    contentType: 'audio/mpeg',
    sizeBytes: retryContent.length,
    sha256Hex: sha256(retryContent),
  });
  await appendFileUploadChunk(pool, store, {
    userId: firstUser,
    uploadId: retry.id,
    offset: 0,
    content: retryContent.subarray(0, 3),
  });
  await pool.query(
    `UPDATE file_uploads SET expires_at = now() - interval '1 second'
     WHERE user_id = $1 AND id = $2`,
    [firstUser, retry.id],
  );
  let abortFails = true;
  const flakyStore = {
    provider: store.provider,
    uploadStrategy: store.uploadStrategy,
    put: store.put.bind(store),
    read: store.read.bind(store),
    copyToFile: store.copyToFile.bind(store),
    delete: store.delete.bind(store),
    appendUploadChunk: store.appendUploadChunk.bind(store),
    readUploadPrefix: store.readUploadPrefix.bind(store),
    completeUpload: store.completeUpload.bind(store),
    async abortUpload(uploadId) {
      if (abortFails) {
        abortFails = false;
        throw new Error('temporary_upload_cleanup_failure');
      }
      await store.abortUpload(uploadId);
    },
  };
  assert.deepEqual(await cleanupNextExpiredFileUpload(pool, flakyStore), {
    uploadId: retry.id,
    cleaned: false,
  });
  const failedCleanup = await pool.query(
    `SELECT status, error_code, cleanup_attempt_count
     FROM file_uploads WHERE user_id = $1 AND id = $2`,
    [firstUser, retry.id],
  );
  assert.deepEqual(failedCleanup.rows[0], {
    status: 'cancelling',
    error_code: 'temporary_upload_cleanup_failure',
    cleanup_attempt_count: 1,
  });
  await pool.query(
    `UPDATE file_uploads
     SET cleanup_lease_expires_at = now() - interval '1 second'
     WHERE user_id = $1 AND id = $2`,
    [firstUser, retry.id],
  );
  assert.deepEqual(await cleanupNextExpiredFileUpload(pool, flakyStore), {
    uploadId: retry.id,
    cleaned: true,
  });

  console.log(
    'file upload smoke test passed: idempotent creation, tenant isolation, resumable offsets, concurrent chunk serialization, integrity verification, completion crash recovery, cancellation, expired cleanup, and cleanup retry',
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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

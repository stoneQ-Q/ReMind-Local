import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  normalizeObjectOriginalName,
  objectFilePolicy,
} from './object-files.js';
import {
  isResumableObjectStore,
  type ObjectStore,
  type ResumableObjectStore,
} from './object-store.js';

const UPLOAD_TTL_HOURS = 24;
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const CLEANUP_LEASE_SECONDS = 60;

type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'completing'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

type UploadRow = {
  id: string;
  user_id: string;
  file_id: string;
  idempotency_key: string;
  strategy: 'proxy_chunks' | 'provider_multipart';
  status: UploadStatus;
  expected_size_bytes: string;
  uploaded_size_bytes: string;
  expected_sha256_hex: string;
  chunk_size_bytes: number;
  expires_at: Date;
  error_code: string | null;
  cleanup_lease_token: string | null;
  cleanup_attempt_count: number;
  created_at: Date;
  updated_at: Date;
  content_type: string;
  media_kind: 'image' | 'audio' | 'video' | 'document';
  object_key: string;
  original_name: string | null;
};

export type FileUploadSnapshot = {
  id: string;
  fileId: string;
  strategy: 'proxy_chunks' | 'provider_multipart';
  status: UploadStatus;
  contentType: string;
  mediaKind: 'image' | 'audio' | 'video' | 'document';
  originalName: string | null;
  expectedSizeBytes: number;
  uploadedSizeBytes: number;
  expectedSha256Hex: string;
  chunkSizeBytes: number;
  expiresAt: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export class FileUploadError extends Error {
  constructor(
    readonly code:
      | 'upload_not_found'
      | 'upload_strategy_unavailable'
      | 'upload_idempotency_conflict'
      | 'upload_not_writable'
      | 'upload_not_completable'
      | 'upload_already_completed'
      | 'upload_expired'
      | 'upload_offset_mismatch'
      | 'unsupported_media_type'
      | 'invalid_idempotency_key'
      | 'invalid_upload_size'
      | 'invalid_upload_digest'
      | 'invalid_upload_chunk'
      | 'upload_content_type_mismatch',
  ) {
    super(code);
  }
}

export async function createFileUpload(
  pool: Pool,
  store: ObjectStore,
  input: {
    userId: string;
    idempotencyKey: string;
    contentType: string;
    sizeBytes: number;
    sha256Hex: string;
    originalName?: string;
  },
): Promise<FileUploadSnapshot> {
  requireUuid(input.userId);
  const resumable = requireResumableStore(store);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  let policy: ReturnType<typeof objectFilePolicy>;
  try {
    policy = objectFilePolicy(input.contentType);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'unsupported_media_type'
    ) {
      throw new FileUploadError('unsupported_media_type');
    }
    throw error;
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > policy.maximumBytes
  ) {
    throw new FileUploadError('invalid_upload_size');
  }
  const sha256Hex = input.sha256Hex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) {
    throw new FileUploadError('invalid_upload_digest');
  }
  const originalName = normalizeObjectOriginalName(input.originalName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query(
      `SELECT id FROM users
       WHERE id = $1 AND status = 'active'
       FOR UPDATE`,
      [input.userId],
    );
    if (!owner.rowCount) throw new Error('user_not_found');
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1 || ':' || $2, 0)
       )`,
      [input.userId, idempotencyKey],
    );
    const existing = await findUploadByIdempotency(
      client,
      input.userId,
      idempotencyKey,
    );
    if (existing) {
      assertSameUpload(existing, {
        contentType: policy.contentType,
        sizeBytes: input.sizeBytes,
        sha256Hex,
        originalName,
      });
      await client.query('COMMIT');
      return uploadSnapshot(existing);
    }

    const uploadId = randomUUID();
    const fileId = randomUUID();
    const objectKey =
      `users/${input.userId}/source/${fileId}.${policy.extension}`;
    await client.query(
      `INSERT INTO files (
         id, user_id, object_key, content_type, size_bytes, sha256_hex,
         storage_provider, purpose, media_kind, status, original_name
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, 'source', $8, 'pending', $9
       )`,
      [
        fileId,
        input.userId,
        objectKey,
        policy.contentType,
        input.sizeBytes,
        sha256Hex,
        resumable.provider,
        policy.kind,
        originalName,
      ],
    );
    await client.query(
      `INSERT INTO file_uploads (
         id, user_id, file_id, idempotency_key, strategy,
         expected_size_bytes, expected_sha256_hex, chunk_size_bytes,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, now() + make_interval(hours => $9)
       )`,
      [
        uploadId,
        input.userId,
        fileId,
        idempotencyKey,
        resumable.uploadStrategy,
        input.sizeBytes,
        sha256Hex,
        UPLOAD_CHUNK_BYTES,
        UPLOAD_TTL_HOURS,
      ],
    );
    const created = requiredRow(
      (
        await selectUpload(client, input.userId, uploadId, true)
      ).rows[0],
    );
    await client.query('COMMIT');
    return uploadSnapshot(created);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserFileUpload(
  pool: Pool,
  userId: string,
  uploadId: string,
): Promise<FileUploadSnapshot | null> {
  requireUuid(userId);
  requireUuid(uploadId);
  const result = await selectUpload(pool, userId, uploadId, false);
  return result.rows[0] ? uploadSnapshot(result.rows[0]) : null;
}

export async function appendFileUploadChunk(
  pool: Pool,
  store: ObjectStore,
  input: {
    userId: string;
    uploadId: string;
    offset: number;
    content: Uint8Array;
  },
): Promise<FileUploadSnapshot> {
  requireUuid(input.userId);
  requireUuid(input.uploadId);
  const resumable = requireResumableStore(store);
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.content.byteLength < 1 ||
    input.content.byteLength > UPLOAD_CHUNK_BYTES
  ) {
    throw new FileUploadError('invalid_upload_chunk');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = requiredUpload(
      (
        await selectUpload(client, input.userId, input.uploadId, true)
      ).rows[0],
    );
    if (row.expires_at.getTime() <= Date.now()) {
      throw new FileUploadError('upload_expired');
    }
    if (row.status !== 'pending' && row.status !== 'uploading') {
      throw new FileUploadError('upload_not_writable');
    }
    const uploaded = Number(row.uploaded_size_bytes);
    const expected = Number(row.expected_size_bytes);
    if (input.offset !== uploaded) {
      throw new FileUploadError('upload_offset_mismatch');
    }
    if (
      input.content.byteLength > row.chunk_size_bytes ||
      uploaded + input.content.byteLength > expected
    ) {
      throw new FileUploadError('invalid_upload_chunk');
    }
    const nextOffset = await resumable.appendUploadChunk(
      row.id,
      uploaded,
      input.content,
    );
    const updated = await client.query<UploadRow>(
      `${uploadSelect()}
       WHERE upload.user_id = $1 AND upload.id = $2`,
      [input.userId, input.uploadId],
    );
    await client.query(
      `UPDATE file_uploads
       SET status = 'uploading',
           uploaded_size_bytes = $1,
           error_code = NULL,
           updated_at = now()
       WHERE user_id = $2 AND id = $3`,
      [nextOffset, input.userId, input.uploadId],
    );
    const snapshot = {
      ...requiredRow(updated.rows[0]),
      status: 'uploading' as const,
      uploaded_size_bytes: String(nextOffset),
      updated_at: new Date(),
    };
    await client.query('COMMIT');
    return uploadSnapshot(snapshot);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeFileUpload(
  pool: Pool,
  store: ObjectStore,
  userId: string,
  uploadId: string,
): Promise<FileUploadSnapshot> {
  requireUuid(userId);
  requireUuid(uploadId);
  const resumable = requireResumableStore(store);
  const prepared = await markUploadCompleting(pool, userId, uploadId);
  if (prepared.status === 'succeeded') return uploadSnapshot(prepared);
  try {
    const prefix = await resumable.readUploadPrefix(
      prepared.id,
      prepared.object_key,
      16,
    );
    if (!matchesMediaSignature(prepared.content_type, prefix)) {
      throw new FileUploadError('upload_content_type_mismatch');
    }
    await resumable.completeUpload(
      prepared.id,
      prepared.object_key,
      Number(prepared.expected_size_bytes),
      prepared.expected_sha256_hex,
    );
  } catch (error) {
    if (isPermanentIntegrityError(error)) {
      await resumable.abortUpload(prepared.id).catch(() => undefined);
      await resumable.delete(prepared.object_key).catch(() => undefined);
      await pool.query(
        `UPDATE file_uploads AS upload
         SET status = 'failed',
             error_code = $1,
             finished_at = now(),
             updated_at = now()
         FROM files AS file
         WHERE upload.user_id = $2 AND upload.id = $3
           AND file.user_id = upload.user_id AND file.id = upload.file_id`,
        [normalizeErrorCode(error), userId, uploadId],
      );
      await pool.query(
        `UPDATE files
         SET status = 'failed',
             last_error_code = $1,
             updated_at = now()
         WHERE user_id = $2 AND id = $3 AND status = 'pending'`,
        [normalizeErrorCode(error), userId, prepared.file_id],
      );
    }
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = requiredUpload(
      (
        await selectUpload(client, userId, uploadId, true)
      ).rows[0],
    );
    if (current.status === 'succeeded') {
      await client.query('COMMIT');
      return uploadSnapshot(current);
    }
    if (current.status !== 'completing') {
      throw new FileUploadError('upload_not_completable');
    }
    const file = await client.query(
      `UPDATE files
       SET status = 'ready',
           last_error_code = NULL,
           updated_at = now()
       WHERE user_id = $1 AND id = $2 AND status = 'pending'`,
      [userId, current.file_id],
    );
    if (file.rowCount !== 1) throw new Error('file_state_changed');
    await client.query(
      `UPDATE file_uploads
       SET status = 'succeeded',
           cleanup_lease_token = NULL,
           cleanup_lease_expires_at = NULL,
           error_code = NULL,
           finished_at = now(),
           updated_at = now()
       WHERE user_id = $1 AND id = $2 AND status = 'completing'`,
      [userId, uploadId],
    );
    const completed = requiredRow(
      (
        await selectUpload(client, userId, uploadId, false)
      ).rows[0],
    );
    await client.query('COMMIT');
    return uploadSnapshot(completed);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelFileUpload(
  pool: Pool,
  store: ObjectStore,
  userId: string,
  uploadId: string,
): Promise<FileUploadSnapshot | null> {
  requireUuid(userId);
  requireUuid(uploadId);
  const claimed = await claimUploadCleanup(pool, userId, uploadId, false);
  if (!claimed) return null;
  if (claimed.status === 'succeeded') {
    throw new FileUploadError('upload_already_completed');
  }
  if (claimed.status === 'cancelled' || claimed.status === 'failed') {
    return uploadSnapshot(claimed);
  }
  await finishUploadCleanup(pool, requireResumableStore(store), claimed);
  return getUserFileUpload(pool, userId, uploadId);
}

export async function cleanupNextExpiredFileUpload(
  pool: Pool,
  store: ObjectStore,
): Promise<{ uploadId: string; cleaned: boolean } | null> {
  const claimed = await claimUploadCleanup(pool, null, null, true);
  if (!claimed) return null;
  try {
    await finishUploadCleanup(pool, requireResumableStore(store), claimed);
    return { uploadId: claimed.id, cleaned: true };
  } catch {
    return { uploadId: claimed.id, cleaned: false };
  }
}

async function markUploadCompleting(
  pool: Pool,
  userId: string,
  uploadId: string,
): Promise<UploadRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = requiredUpload(
      (
        await selectUpload(client, userId, uploadId, true)
      ).rows[0],
    );
    if (row.status === 'succeeded') {
      await client.query('COMMIT');
      return row;
    }
    if (
      row.status !== 'pending' &&
      row.status !== 'uploading' &&
      row.status !== 'completing'
    ) {
      throw new FileUploadError('upload_not_completable');
    }
    if (row.expires_at.getTime() <= Date.now()) {
      throw new FileUploadError('upload_expired');
    }
    if (row.uploaded_size_bytes !== row.expected_size_bytes) {
      throw new FileUploadError('upload_not_completable');
    }
    await client.query(
      `UPDATE file_uploads
       SET status = 'completing', updated_at = now()
       WHERE user_id = $1 AND id = $2`,
      [userId, uploadId],
    );
    await client.query('COMMIT');
    return { ...row, status: 'completing' };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function claimUploadCleanup(
  pool: Pool,
  userId: string | null,
  uploadId: string | null,
  expiredOnly: boolean,
): Promise<UploadRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<UploadRow>(
      `${uploadSelect()}
       WHERE (
         ($1::uuid IS NOT NULL AND upload.user_id = $1 AND upload.id = $2)
         OR
         (
           $1::uuid IS NULL
           AND (
             (
               upload.status IN ('pending', 'uploading', 'completing')
               AND upload.expires_at <= now()
             )
             OR (
               upload.status = 'cancelling'
               AND upload.cleanup_lease_expires_at <= now()
             )
           )
         )
       )
       ORDER BY upload.expires_at, upload.created_at, upload.id
       FOR UPDATE OF upload SKIP LOCKED
       LIMIT 1`,
      [userId, uploadId],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    if (
      !expiredOnly &&
      (row.status === 'succeeded' ||
        row.status === 'failed' ||
        row.status === 'cancelled')
    ) {
      await client.query('COMMIT');
      return row;
    }
    const claimed = await client.query<UploadRow>(
      `${uploadSelect()}
       WHERE upload.user_id = $1 AND upload.id = $2`,
      [row.user_id, row.id],
    );
    const leaseToken = randomUUID();
    await client.query(
      `UPDATE file_uploads
       SET status = 'cancelling',
           cleanup_attempt_count = cleanup_attempt_count + 1,
           cleanup_lease_token = $1,
           cleanup_lease_expires_at =
             now() + make_interval(secs => $2),
           updated_at = now()
       WHERE user_id = $3 AND id = $4`,
      [leaseToken, CLEANUP_LEASE_SECONDS, row.user_id, row.id],
    );
    await client.query('COMMIT');
    return {
      ...requiredRow(claimed.rows[0]),
      status: 'cancelling',
      cleanup_lease_token: leaseToken,
      cleanup_attempt_count: row.cleanup_attempt_count + 1,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function finishUploadCleanup(
  pool: Pool,
  store: ResumableObjectStore,
  row: UploadRow,
): Promise<void> {
  try {
    await store.abortUpload(row.id);
    await store.delete(row.object_key);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE files
         SET status = 'deleted',
             deleted_at = COALESCE(deleted_at, now()),
             last_error_code = NULL,
             updated_at = now()
         WHERE user_id = $1 AND id = $2 AND status <> 'ready'`,
        [row.user_id, row.file_id],
      );
      await client.query(
        `UPDATE file_uploads
         SET status = 'cancelled',
             cleanup_lease_token = NULL,
             cleanup_lease_expires_at = NULL,
             error_code = NULL,
             finished_at = now(),
             updated_at = now()
         WHERE user_id = $1 AND id = $2
           AND status = 'cancelling'
           AND cleanup_lease_token = $3`,
        [row.user_id, row.id, row.cleanup_lease_token],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.query(
      `UPDATE file_uploads
       SET error_code = $1,
           cleanup_lease_expires_at =
             now() + make_interval(secs => $2),
           updated_at = now()
       WHERE user_id = $3 AND id = $4
         AND status = 'cancelling'
         AND cleanup_lease_token = $5`,
      [
        normalizeErrorCode(error),
        cleanupRetrySeconds(row.cleanup_attempt_count),
        row.user_id,
        row.id,
        row.cleanup_lease_token,
      ],
    );
    throw error;
  }
}

async function findUploadByIdempotency(
  client: PoolClient,
  userId: string,
  idempotencyKey: string,
): Promise<UploadRow | null> {
  const result = await client.query<UploadRow>(
    `${uploadSelect()}
     WHERE upload.user_id = $1 AND upload.idempotency_key = $2
     FOR UPDATE OF upload`,
    [userId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function selectUpload(
  client: Pool | PoolClient,
  userId: string,
  uploadId: string,
  lock: boolean,
) {
  return client.query<UploadRow>(
    `${uploadSelect()}
     WHERE upload.user_id = $1 AND upload.id = $2
     ${lock ? 'FOR UPDATE OF upload' : ''}`,
    [userId, uploadId],
  );
}

function uploadSelect(): string {
  return `SELECT upload.id, upload.user_id, upload.file_id,
                 upload.idempotency_key, upload.strategy, upload.status,
                 upload.expected_size_bytes, upload.uploaded_size_bytes,
                 upload.expected_sha256_hex, upload.chunk_size_bytes,
                 upload.expires_at, upload.error_code,
                 upload.cleanup_lease_token, upload.cleanup_attempt_count,
                 upload.created_at, upload.updated_at,
                 file.content_type, file.media_kind, file.object_key,
                 file.original_name
          FROM file_uploads AS upload
          JOIN files AS file
            ON file.user_id = upload.user_id AND file.id = upload.file_id`;
}

function assertSameUpload(
  row: UploadRow,
  expected: {
    contentType: string;
    sizeBytes: number;
    sha256Hex: string;
    originalName: string | null;
  },
): void {
  if (
    row.content_type !== expected.contentType ||
    Number(row.expected_size_bytes) !== expected.sizeBytes ||
    row.expected_sha256_hex !== expected.sha256Hex ||
    row.original_name !== expected.originalName
  ) {
    throw new FileUploadError('upload_idempotency_conflict');
  }
}

function uploadSnapshot(row: UploadRow): FileUploadSnapshot {
  return {
    id: row.id,
    fileId: row.file_id,
    strategy: row.strategy,
    status: row.status,
    contentType: row.content_type,
    mediaKind: row.media_kind,
    originalName: row.original_name,
    expectedSizeBytes: Number(row.expected_size_bytes),
    uploadedSizeBytes: Number(row.uploaded_size_bytes),
    expectedSha256Hex: row.expected_sha256_hex,
    chunkSizeBytes: row.chunk_size_bytes,
    expiresAt: row.expires_at.toISOString(),
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function requireResumableStore(store: ObjectStore): ResumableObjectStore {
  if (!isResumableObjectStore(store)) {
    throw new FileUploadError('upload_strategy_unavailable');
  }
  return store;
}

function requiredUpload(row: UploadRow | undefined): UploadRow {
  if (!row) throw new FileUploadError('upload_not_found');
  return row;
}

function requireIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new FileUploadError('invalid_idempotency_key');
  }
  return normalized;
}

function requireUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error('invalid_id');
  }
}

function cleanupRetrySeconds(attempt: number): number {
  return Math.min(3_600, 2 ** Math.min(10, attempt) * 5);
}

function isPermanentIntegrityError(error: unknown): boolean {
  return (
    (error instanceof FileUploadError &&
      error.code === 'upload_content_type_mismatch') ||
    (error instanceof Error &&
      (error.message === 'upload_integrity_mismatch' ||
        error.message === 'upload_target_conflict'))
  );
}

function matchesMediaSignature(
  contentType: string,
  content: Uint8Array,
): boolean {
  if (contentType === 'image/jpeg') {
    return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return Buffer.from(content.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (contentType === 'image/webp') {
    return ascii(content, 0, 4) === 'RIFF' && ascii(content, 8, 12) === 'WEBP';
  }
  if (contentType === 'audio/mpeg') {
    return (
      ascii(content, 0, 3) === 'ID3' ||
      (content[0] === 0xff && ((content[1] ?? 0) & 0xe0) === 0xe0)
    );
  }
  if (contentType === 'audio/wav') {
    return ascii(content, 0, 4) === 'RIFF' && ascii(content, 8, 12) === 'WAVE';
  }
  if (contentType === 'audio/ogg') {
    return ascii(content, 0, 4) === 'OggS';
  }
  if (contentType === 'audio/webm' || contentType === 'video/webm') {
    return (
      content[0] === 0x1a &&
      content[1] === 0x45 &&
      content[2] === 0xdf &&
      content[3] === 0xa3
    );
  }
  if (
    contentType === 'audio/mp4' ||
    contentType === 'video/mp4' ||
    contentType === 'video/quicktime'
  ) {
    return ascii(content, 4, 8) === 'ftyp';
  }
  return false;
}

function ascii(content: Uint8Array, start: number, end: number): string {
  return Buffer.from(content.subarray(start, end)).toString('ascii');
}

function normalizeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : 'upload_failed';
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '_')
      .slice(0, 80) || 'upload_failed'
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original error.
  }
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { Pool, PoolClient } from 'pg';

import type { ObjectStore } from './object-store.js';

const DEFAULT_TEMPORARY_TTL_SECONDS = 24 * 60 * 60;
const MIN_TEMPORARY_TTL_SECONDS = 5 * 60;
const MAX_TEMPORARY_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLEANUP_LEASE_SECONDS = 60;

type MediaKind = 'image' | 'audio' | 'video' | 'document';
type FilePurpose = 'source' | 'temporary' | 'result';

type FileRow = {
  id: string;
  user_id: string;
  object_key: string;
  content_type: string;
  size_bytes: string;
  sha256_hex: string;
  status: 'pending' | 'ready' | 'deleting' | 'deleted' | 'failed';
};

type CleanupClaim = {
  id: string;
  user_id: string;
  object_key: string;
  cleanup_lease_token: string;
  deletion_attempt_count: number;
};

export type StoredObjectFile = {
  id: string;
  contentType: string;
  mediaKind: MediaKind;
  purpose: FilePurpose;
  sizeBytes: number;
  sha256Hex: string;
  expiresAt: string | null;
};

export async function getUserObjectFileMetadata(
  pool: Pool,
  userId: string,
  fileId: string,
): Promise<{ contentType: string; mediaKind: MediaKind } | null> {
  const result = await pool.query<{
    content_type: string;
    media_kind: MediaKind;
  }>(
    `SELECT content_type, media_kind
     FROM files
     WHERE user_id = $1 AND id = $2
       AND status = 'ready' AND deleted_at IS NULL`,
    [userId, fileId],
  );
  const row = result.rows[0];
  return row
    ? { contentType: row.content_type, mediaKind: row.media_kind }
    : null;
}

export async function saveObjectFile(
  pool: Pool,
  store: ObjectStore,
  input: {
    userId: string;
    contentType: string;
    content: Uint8Array;
    purpose: FilePurpose;
    originalName?: string;
    temporaryTtlSeconds?: number;
  },
): Promise<StoredObjectFile> {
  requireUuid(input.userId);
  const media = mediaPolicy(input.contentType);
  if (
    input.content.byteLength === 0 ||
    input.content.byteLength > media.maximumBytes
  ) {
    throw new Error('invalid_media_size');
  }
  const temporaryTtl =
    input.purpose === 'temporary'
      ? validTemporaryTtl(input.temporaryTtlSeconds)
      : null;
  const fileId = randomUUID();
  const objectKey =
    `users/${input.userId}/${input.purpose}/${fileId}.${media.extension}`;
  const sha256Hex = createHash('sha256').update(input.content).digest('hex');
  const originalName = normalizeOriginalName(input.originalName);
  const inserted = await pool.query<{ expires_at: Date | null }>(
    `INSERT INTO files (
       id, user_id, object_key, content_type, size_bytes, sha256_hex,
       storage_provider, purpose, media_kind, status, original_name,
       expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, 'pending', $10,
       CASE WHEN $11::integer IS NULL
         THEN NULL
         ELSE now() + make_interval(secs => $11)
       END
     )
     RETURNING expires_at`,
    [
      fileId,
      input.userId,
      objectKey,
      media.contentType,
      input.content.byteLength,
      sha256Hex,
      store.provider,
      input.purpose,
      media.kind,
      originalName,
      temporaryTtl,
    ],
  );
  let stored = false;
  try {
    await store.put(objectKey, input.content);
    stored = true;
    const updated = await pool.query(
      `UPDATE files
       SET status = 'ready', updated_at = now()
       WHERE user_id = $1 AND id = $2 AND status = 'pending'`,
      [input.userId, fileId],
    );
    if (updated.rowCount !== 1) throw new Error('file_state_changed');
  } catch (error) {
    if (stored) await store.delete(objectKey).catch(() => undefined);
    await pool.query(
      `UPDATE files
       SET status = 'failed',
           last_error_code = $1,
           updated_at = now()
       WHERE user_id = $2 AND id = $3 AND status = 'pending'`,
      [normalizeErrorCode(error), input.userId, fileId],
    );
    throw error;
  }
  return {
    id: fileId,
    contentType: media.contentType,
    mediaKind: media.kind,
    purpose: input.purpose,
    sizeBytes: input.content.byteLength,
    sha256Hex,
    expiresAt: inserted.rows[0]?.expires_at?.toISOString() ?? null,
  };
}

export async function readUserObjectFile(
  pool: Pool,
  store: ObjectStore,
  userId: string,
  fileId: string,
): Promise<Buffer> {
  requireUuid(userId);
  requireUuid(fileId);
  const result = await pool.query<FileRow>(
    `SELECT id, user_id, object_key, content_type, size_bytes,
            sha256_hex, status
     FROM files
     WHERE user_id = $1 AND id = $2
       AND status = 'ready' AND deleted_at IS NULL`,
    [userId, fileId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('file_not_found');
  const expectedSize = Number(row.size_bytes);
  const content = await store.read(row.object_key, expectedSize);
  if (
    content.byteLength !== expectedSize ||
    createHash('sha256').update(content).digest('hex') !== row.sha256_hex
  ) {
    throw new Error('object_integrity_mismatch');
  }
  await pool.query(
    `UPDATE files
     SET last_accessed_at = now(), updated_at = now()
     WHERE user_id = $1 AND id = $2 AND status = 'ready'`,
    [userId, fileId],
  );
  return content;
}

export async function materializeUserObjectFile(
  pool: Pool,
  store: ObjectStore,
  userId: string,
  fileId: string,
  destinationPath: string,
): Promise<{ contentType: string; sizeBytes: number }> {
  requireUuid(userId);
  requireUuid(fileId);
  const result = await pool.query<FileRow>(
    `SELECT id, user_id, object_key, content_type, size_bytes,
            sha256_hex, status
     FROM files
     WHERE user_id = $1 AND id = $2
       AND status = 'ready' AND deleted_at IS NULL`,
    [userId, fileId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('file_not_found');
  const expectedSize = Number(row.size_bytes);
  await store.copyToFile(row.object_key, destinationPath, expectedSize);
  const metadata = await stat(destinationPath);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(destinationPath)) {
    digest.update(chunk as Buffer);
  }
  if (
    !metadata.isFile() ||
    metadata.size !== expectedSize ||
    digest.digest('hex') !== row.sha256_hex
  ) {
    throw new Error('object_integrity_mismatch');
  }
  await pool.query(
    `UPDATE files
     SET last_accessed_at = now(), updated_at = now()
     WHERE user_id = $1 AND id = $2 AND status = 'ready'`,
    [userId, fileId],
  );
  return { contentType: row.content_type, sizeBytes: expectedSize };
}

export async function cleanupNextExpiredObject(
  pool: Pool,
  store: ObjectStore,
): Promise<{ fileId: string; deleted: boolean } | null> {
  const claim = await claimCleanup(pool, store.provider);
  if (!claim) return null;
  try {
    await store.delete(claim.object_key);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE files
         SET status = 'deleted',
             deleted_at = COALESCE(deleted_at, now()),
             cleanup_lease_token = NULL,
             cleanup_lease_expires_at = NULL,
             last_error_code = NULL,
             updated_at = now()
         WHERE user_id = $1 AND id = $2
           AND status = 'deleting'
           AND cleanup_lease_token = $3`,
        [claim.user_id, claim.id, claim.cleanup_lease_token],
      );
      await client.query(
        `UPDATE file_deletion_attempts
         SET status = 'succeeded', error_code = NULL, finished_at = now()
         WHERE user_id = $1 AND file_id = $2 AND lease_token = $3
           AND status = 'running'`,
        [claim.user_id, claim.id, claim.cleanup_lease_token],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
    return { fileId: claim.id, deleted: true };
  } catch (error) {
    const errorCode = normalizeErrorCode(error);
    const retrySeconds = Math.min(
      3600,
      2 ** Math.min(10, claim.deletion_attempt_count) * 5,
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE files
         SET status = 'deleting',
             cleanup_lease_expires_at =
               now() + make_interval(secs => $1),
             last_error_code = $2,
             updated_at = now()
         WHERE user_id = $3 AND id = $4
           AND cleanup_lease_token = $5`,
        [
          retrySeconds,
          errorCode,
          claim.user_id,
          claim.id,
          claim.cleanup_lease_token,
        ],
      );
      await client.query(
        `UPDATE file_deletion_attempts
         SET status = 'failed', error_code = $1, finished_at = now()
         WHERE user_id = $2 AND file_id = $3 AND lease_token = $4
           AND status = 'running'`,
        [errorCode, claim.user_id, claim.id, claim.cleanup_lease_token],
      );
      await client.query('COMMIT');
    } catch (databaseError) {
      await rollbackQuietly(client);
      throw databaseError;
    } finally {
      client.release();
    }
    return { fileId: claim.id, deleted: false };
  }
}

async function claimCleanup(
  pool: Pool,
  provider: ObjectStore['provider'],
): Promise<CleanupClaim | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query<{
      id: string;
      user_id: string;
      cleanup_lease_token: string | null;
    }>(
      `SELECT id, user_id, cleanup_lease_token
       FROM files
       WHERE storage_provider = $1
         AND deleted_at IS NULL
         AND (
           (
             purpose = 'temporary'
             AND status = 'ready'
             AND expires_at <= now()
           )
           OR
           (
             status = 'pending'
             AND created_at <= now() - interval '10 minutes'
           )
           OR
           (
             status = 'deleting'
             AND cleanup_lease_expires_at <= now()
           )
         )
       ORDER BY expires_at, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [provider],
    );
    const selected = candidate.rows[0];
    if (!selected) {
      await client.query('COMMIT');
      return null;
    }
    if (selected.cleanup_lease_token) {
      await client.query(
        `UPDATE file_deletion_attempts
         SET status = 'failed',
             error_code = 'cleanup_lease_expired',
             finished_at = now()
         WHERE user_id = $1 AND file_id = $2 AND lease_token = $3
           AND status = 'running'`,
        [selected.user_id, selected.id, selected.cleanup_lease_token],
      );
    }
    const claimed = await client.query<CleanupClaim>(
      `UPDATE files
       SET status = 'deleting',
           deletion_attempt_count = deletion_attempt_count + 1,
           cleanup_lease_token = gen_random_uuid(),
           cleanup_lease_expires_at =
             now() + make_interval(secs => $3),
           updated_at = now()
       WHERE user_id = $1 AND id = $2
       RETURNING id, user_id, object_key, cleanup_lease_token,
                 deletion_attempt_count`,
      [selected.user_id, selected.id, CLEANUP_LEASE_SECONDS],
    );
    const row = requiredRow(claimed.rows[0]);
    await client.query(
      `INSERT INTO file_deletion_attempts (
         user_id, file_id, attempt_number, lease_token, status
       ) VALUES ($1, $2, $3, $4, 'running')`,
      [
        row.user_id,
        row.id,
        row.deletion_attempt_count,
        row.cleanup_lease_token,
      ],
    );
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

function mediaPolicy(contentTypeValue: string): {
  contentType: string;
  kind: MediaKind;
  extension: string;
  maximumBytes: number;
} {
  const contentType = contentTypeValue.trim().toLowerCase().split(';', 1)[0];
  const policy = MEDIA_POLICIES.get(contentType ?? '');
  if (!policy) throw new Error('unsupported_media_type');
  return { contentType: contentType ?? '', ...policy };
}

const MEDIA_POLICIES = new Map<
  string,
  { kind: MediaKind; extension: string; maximumBytes: number }
>([
  ['image/jpeg', { kind: 'image', extension: 'jpg', maximumBytes: 20_000_000 }],
  ['image/png', { kind: 'image', extension: 'png', maximumBytes: 20_000_000 }],
  ['image/webp', { kind: 'image', extension: 'webp', maximumBytes: 20_000_000 }],
  ['audio/mpeg', { kind: 'audio', extension: 'mp3', maximumBytes: 100_000_000 }],
  ['audio/mp4', { kind: 'audio', extension: 'm4a', maximumBytes: 100_000_000 }],
  ['audio/wav', { kind: 'audio', extension: 'wav', maximumBytes: 100_000_000 }],
  ['audio/webm', { kind: 'audio', extension: 'webm', maximumBytes: 100_000_000 }],
  ['audio/ogg', { kind: 'audio', extension: 'ogg', maximumBytes: 100_000_000 }],
  ['video/mp4', { kind: 'video', extension: 'mp4', maximumBytes: 1_073_741_824 }],
  [
    'video/quicktime',
    { kind: 'video', extension: 'mov', maximumBytes: 1_073_741_824 },
  ],
  ['video/webm', { kind: 'video', extension: 'webm', maximumBytes: 1_073_741_824 }],
]);

function validTemporaryTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TEMPORARY_TTL_SECONDS;
  if (
    !Number.isInteger(ttl) ||
    ttl < MIN_TEMPORARY_TTL_SECONDS ||
    ttl > MAX_TEMPORARY_TTL_SECONDS
  ) {
    throw new Error('invalid_temporary_ttl');
  }
  return ttl;
}

function normalizeOriginalName(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F/\\]+/g, '_')
    .trim()
    .slice(0, 255);
  return normalized || null;
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

function normalizeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : 'object_cleanup_failed';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'object_cleanup_failed';
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error.
  }
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

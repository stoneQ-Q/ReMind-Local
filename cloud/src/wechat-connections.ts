import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import type { JobHandler } from './jobs.js';
import { parseLinkInput } from './link-input.js';
import { validatePublicLinkUrl } from './link-page.js';
import {
  IlinkWechatProtocolClient,
  normalizeWechatMessage,
  validateWechatCredentials,
  type NormalizedWechatCapture,
  type WechatMessage,
  type WechatProtocolClient,
  type WechatProtocolCredentials,
} from './wechat-protocol.js';

const WECHAT_JOB_TYPE = 'wechat.poll';

type ConnectionRow = {
  id: string;
  user_id: string;
  reply_mode: 'first' | 'always' | 'silent';
  encrypted_credentials: Buffer;
  encryption_key_version: string;
  cursor: string;
  polling_timeout_ms: number;
};

export async function saveWechatConnection(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  rawCredentials: WechatProtocolCredentials,
  replyMode: 'first' | 'always' | 'silent' = 'first',
): Promise<string> {
  const credentials = validateWechatCredentials(rawCredentials);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{
      id: string;
      poll_job_id: string | null;
    }>(
      `SELECT id, poll_job_id
       FROM wechat_connections
       WHERE user_id = $1 AND revoked_at IS NULL
       FOR UPDATE`,
      [userId],
    );
    const connectionId = existing.rows[0]?.id ?? randomUUID();
    const encrypted = cipher.encrypt(JSON.stringify(credentials), {
      userId,
      provider: credentialContext(connectionId),
    });
    const providerSubjectHash = createHash('sha256')
      .update(credentials.allowedUserId)
      .digest('hex');
    if (existing.rows[0]) {
      if (existing.rows[0].poll_job_id) {
        await client.query(
          `UPDATE jobs
           SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
               updated_at = now()
           WHERE user_id = $1 AND id = $2
             AND status IN ('queued', 'reserved', 'running')`,
          [userId, existing.rows[0].poll_job_id],
        );
      }
      await client.query(
        `UPDATE wechat_connections
         SET status = 'active',
             provider_subject_hash = $1,
             encrypted_credentials = $2,
             encryption_key_version = $3,
             reply_mode = $4,
             cursor = '',
             next_poll_at = now(),
             failure_count = 0,
             last_error_code = NULL,
             confirmation_sent_at = NULL,
             poll_generation = poll_generation + 1,
             poll_job_id = NULL,
             updated_at = now()
         WHERE user_id = $5 AND id = $6`,
        [
          providerSubjectHash,
          encrypted.ciphertext,
          encrypted.keyVersion,
          replyMode,
          userId,
          connectionId,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO wechat_connections (
           id, user_id, status, provider_subject_hash,
           encrypted_credentials, encryption_key_version, reply_mode
         ) VALUES ($1, $2, 'active', $3, $4, $5, $6)`,
        [
          connectionId,
          userId,
          providerSubjectHash,
          encrypted.ciphertext,
          encrypted.keyVersion,
          replyMode,
        ],
      );
    }
    await client.query('COMMIT');
    return connectionId;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureNextWechatPollJob(
  pool: Pool,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connection = await client.query<{
      id: string;
      user_id: string;
      poll_generation: string;
    }>(
      `SELECT connection.id, connection.user_id,
              connection.poll_generation
       FROM wechat_connections AS connection
       LEFT JOIN jobs AS current_job
         ON current_job.id = connection.poll_job_id
        AND current_job.user_id = connection.user_id
       WHERE connection.status = 'active'
         AND connection.revoked_at IS NULL
         AND connection.encrypted_credentials IS NOT NULL
         AND connection.next_poll_at <= now()
         AND (
           connection.poll_job_id IS NULL
           OR current_job.status IN ('succeeded', 'failed', 'cancelled')
         )
       ORDER BY connection.next_poll_at, connection.created_at
       FOR UPDATE OF connection SKIP LOCKED
       LIMIT 1`,
    );
    const row = connection.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    const generation = BigInt(row.poll_generation) + 1n;
    const job = await client.query<{ id: string }>(
      `INSERT INTO jobs (
         user_id, type, idempotency_key, input_json,
         max_attempts, timeout_seconds
       ) VALUES (
         $1, $2, $3, $4::jsonb, 3, 120
       )
       RETURNING id`,
      [
        row.user_id,
        WECHAT_JOB_TYPE,
        `wechat-poll:${row.id}:${generation}`,
        JSON.stringify({
          connectionId: row.id,
          generation: generation.toString(),
        }),
      ],
    );
    const jobId = requiredRow(job.rows[0]).id;
    await client.query(
      `UPDATE wechat_connections
       SET poll_generation = $1,
           poll_job_id = $2,
           updated_at = now()
       WHERE user_id = $3 AND id = $4`,
      [generation.toString(), jobId, row.user_id, row.id],
    );
    await client.query('COMMIT');
    return jobId;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export function createWechatPollHandler(
  pool: Pool,
  cipher: CredentialCipher,
  protocol: WechatProtocolClient = new IlinkWechatProtocolClient(),
): JobHandler {
  return async (job, signal) => {
    const { connectionId, generation } = parsePollInput(job.input);
    try {
      const connection = await loadConnection(
        pool,
        cipher,
        job.userId,
        connectionId,
        generation,
        job.id,
      );
      const response = await protocol.getUpdates(
        connection.credentials,
        connection.cursor,
        connection.pollingTimeoutMs,
        signal,
      );
      if (
        (response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0)
      ) {
        throw new Error(
          `wechat_poll_${response.ret ?? response.errcode ?? 'failed'}`,
        );
      }

      let captured = 0;
      for (const message of response.msgs ?? []) {
        if (signal.aborted) throw signal.reason;
        const normalized = normalizeWechatMessage(
          message,
          connection.credentials.allowedUserId,
        );
        if (!normalized) continue;
        const persisted = await persistCapture(
          pool,
          job.userId,
          connectionId,
          generation,
          job.id,
          connection.replyMode,
          normalized,
        );
        if (persisted.inserted) captured += 1;
        if (persisted.shouldReply) {
          await protocol.sendText(
            connection.credentials,
            message,
            'ReMind 已记下。',
            `${connectionId}:${normalized.externalId}`,
            signal,
          );
          await markReplySent(
            pool,
            job.userId,
            connectionId,
            normalized.externalId,
          );
        }
      }

      const pollingTimeoutMs = validPollingTimeout(
        response.longpolling_timeout_ms,
        connection.pollingTimeoutMs,
      );
      await pool.query(
        `UPDATE wechat_connections
         SET cursor = $1,
             polling_timeout_ms = $2,
             next_poll_at = now(),
             failure_count = 0,
             last_error_code = NULL,
             last_polled_at = now(),
             updated_at = now()
         WHERE user_id = $3 AND id = $4
           AND status = 'active' AND revoked_at IS NULL
           AND poll_generation = $5 AND poll_job_id = $6`,
        [
          response.get_updates_buf ?? connection.cursor,
          pollingTimeoutMs,
          job.userId,
          connectionId,
          generation,
          job.id,
        ],
      );
      return { captured, cursorAdvanced: response.get_updates_buf !== undefined };
    } catch (error) {
      const errorCode = normalizeErrorCode(error);
      await pool.query(
        `UPDATE wechat_connections
         SET failure_count = failure_count + 1,
             last_error_code = $1,
             next_poll_at = now() + make_interval(
               secs => LEAST(300, GREATEST(2, (failure_count + 1) * 2))
             ),
             updated_at = now()
         WHERE user_id = $2 AND id = $3
           AND poll_generation = $4 AND poll_job_id = $5`,
        [errorCode, job.userId, connectionId, generation, job.id],
      );
      throw error;
    }
  };
}

async function loadConnection(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  connectionId: string,
  generation: string,
  jobId: string,
): Promise<{
  cursor: string;
  pollingTimeoutMs: number;
  replyMode: ConnectionRow['reply_mode'];
  credentials: WechatProtocolCredentials;
}> {
  const result = await pool.query<ConnectionRow>(
    `SELECT id, user_id, reply_mode, encrypted_credentials,
            encryption_key_version, cursor, polling_timeout_ms
     FROM wechat_connections
     WHERE user_id = $1 AND id = $2
       AND status = 'active' AND revoked_at IS NULL
       AND encrypted_credentials IS NOT NULL
       AND encryption_key_version IS NOT NULL
       AND poll_generation = $3
       AND poll_job_id = $4`,
    [userId, connectionId, generation, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('wechat_connection_not_found');
  const plaintext = cipher.decrypt(
    {
      ciphertext: row.encrypted_credentials,
      keyVersion: row.encryption_key_version,
    },
    { userId, provider: credentialContext(connectionId) },
  );
  const parsed = JSON.parse(plaintext) as WechatProtocolCredentials;
  return {
    cursor: row.cursor,
    pollingTimeoutMs: row.polling_timeout_ms,
    replyMode: row.reply_mode,
    credentials: validateWechatCredentials(parsed),
  };
}

async function persistCapture(
  pool: Pool,
  userId: string,
  connectionId: string,
  generation: string,
  jobId: string,
  replyMode: ConnectionRow['reply_mode'],
  capture: NormalizedWechatCapture,
): Promise<{ inserted: boolean; shouldReply: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connection = await client.query<{
      confirmation_sent_at: Date | null;
    }>(
      `SELECT confirmation_sent_at
       FROM wechat_connections
       WHERE user_id = $1 AND id = $2
         AND status = 'active' AND revoked_at IS NULL
         AND poll_generation = $3 AND poll_job_id = $4
       FOR UPDATE`,
      [userId, connectionId, generation, jobId],
    );
    const currentConnection = connection.rows[0];
    if (!currentConnection) throw new Error('wechat_poll_superseded');

    const duplicate = await client.query<{
      reply_required: boolean;
      reply_sent_at: Date | null;
    }>(
      `SELECT reply_required, reply_sent_at
       FROM wechat_messages
       WHERE user_id = $1 AND connection_id = $2 AND external_id = $3
       FOR UPDATE`,
      [userId, connectionId, capture.externalId],
    );
    if (duplicate.rows[0]) {
      await client.query('COMMIT');
      return {
        inserted: false,
        shouldReply:
          duplicate.rows[0].reply_required &&
          duplicate.rows[0].reply_sent_at === null,
      };
    }

    const confirmationSentAt = currentConnection.confirmation_sent_at;
    const shouldReply =
      replyMode === 'always' ||
      (replyMode === 'first' && confirmationSentAt === null);
    if (shouldReply && replyMode === 'first') {
      await client.query(
        `UPDATE wechat_connections
         SET confirmation_sent_at = now(), updated_at = now()
         WHERE user_id = $1 AND id = $2
           AND confirmation_sent_at IS NULL`,
        [userId, connectionId],
      );
    }

    const noteId = randomUUID();
    const clientId = `wechat:${connectionId}:${capture.externalId}`;
    const link = safeLinkInput(capture.content);
    const contentKind = link
      ? link.userContext || link.urlCount > 1
        ? 'mixed'
        : 'link'
      : 'text';
    const note = await client.query<{ id: string }>(
      `INSERT INTO notes (
         id, user_id, client_id, title, content, source,
         record_type, content_kind, source_url, user_context,
         link_status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'wechat',
         'capture', $6, $7, $8, $9, $10, $10
       )
       ON CONFLICT (user_id, client_id)
       DO UPDATE SET client_id = EXCLUDED.client_id
       RETURNING id`,
      [
        noteId,
        userId,
        clientId,
        noteTitle(capture.content),
        capture.content,
        contentKind,
        link?.url ?? null,
        link?.userContext || null,
        link ? 'pending' : null,
        capture.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO wechat_messages (
         user_id, connection_id, note_id, external_id, type,
         content, source_created_at, reply_required
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        connectionId,
        requiredRow(note.rows[0]).id,
        capture.externalId,
        capture.type,
        capture.content,
        capture.createdAt,
        shouldReply,
      ],
    );
    await client.query('COMMIT');
    return { inserted: true, shouldReply };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function markReplySent(
  pool: Pool,
  userId: string,
  connectionId: string,
  externalId: string,
): Promise<void> {
  await pool.query(
    `UPDATE wechat_messages
     SET reply_sent_at = now()
     WHERE user_id = $1 AND connection_id = $2
       AND external_id = $3 AND reply_required = true`,
    [userId, connectionId, externalId],
  );
}

function parsePollInput(
  input: unknown,
): { connectionId: string; generation: string } {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>).connectionId !== 'string' ||
    typeof (input as Record<string, unknown>).generation !== 'string'
  ) {
    throw new Error('invalid_wechat_poll_input');
  }
  const record = input as Record<string, unknown>;
  const connectionId = record.connectionId;
  const generation = record.generation;
  if (typeof connectionId !== 'string' || typeof generation !== 'string') {
    throw new Error('invalid_wechat_poll_input');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      connectionId,
    ) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(generation)
  ) {
    throw new Error('invalid_wechat_poll_input');
  }
  return { connectionId, generation };
}

function credentialContext(connectionId: string): string {
  return `wechat-ilink:${connectionId}`;
}

function validPollingTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 5_000 &&
    value <= 120_000
    ? value
    : fallback;
}

function noteTitle(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.slice(0, 80) || '微信记录';
}

function safeLinkInput(
  content: string,
): { url: string; userContext: string; urlCount: number } | null {
  const parsed = parseLinkInput(content);
  if (!parsed) return null;
  try {
    return { ...parsed, url: validatePublicLinkUrl(parsed.url) };
  } catch {
    return null;
  }
}

function normalizeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : 'wechat_poll_failed';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'wechat_poll_failed';
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

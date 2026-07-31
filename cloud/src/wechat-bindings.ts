import { randomInt } from 'node:crypto';

import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import { hashSecret } from './secrets.js';
import { saveWechatConnection } from './wechat-connections.js';
import {
  validateWechatCredentials,
  type WechatProtocolCredentials,
} from './wechat-protocol.js';

const BINDING_TTL_MINUTES = 10;

export type CloudWechatStatus = {
  configured: true;
  bound: boolean;
  bindingCode: null;
  expiresAt: null;
  replyMode: 'first' | 'always' | 'silent';
  gatewayOnline: boolean;
  localWhisperAvailable: false;
  aiAvailable: boolean;
  visionAvailable: boolean;
};

export async function createWechatBindingCode(
  pool: Pool,
  userId: string,
): Promise<{ bindingCode: string; expiresAt: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE wechat_binding_codes
       SET claimed_at = now()
       WHERE user_id = $1 AND claimed_at IS NULL`,
      [userId],
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bindingCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO wechat_binding_codes (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))
         ON CONFLICT (code_hash) DO NOTHING
         RETURNING expires_at`,
        [userId, hashSecret(bindingCode), BINDING_TTL_MINUTES],
      );
      const row = inserted.rows[0];
      if (row) {
        await client.query('COMMIT');
        return { bindingCode, expiresAt: row.expires_at.toISOString() };
      }
    }
    throw new Error('wechat_binding_code_collision');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimWechatBindingCode(
  pool: Pool,
  cipher: CredentialCipher,
  bindingCode: string,
  rawCredentials: WechatProtocolCredentials,
): Promise<boolean> {
  if (!/^[0-9]{6}$/.test(bindingCode)) return false;
  const credentials = validateWechatCredentials(rawCredentials);
  const claimed = await pool.query<{ user_id: string }>(
    `UPDATE wechat_binding_codes
     SET claimed_at = now()
     WHERE code_hash = $1
       AND claimed_at IS NULL
       AND expires_at > now()
     RETURNING user_id`,
    [hashSecret(bindingCode)],
  );
  const userId = claimed.rows[0]?.user_id;
  if (!userId) return false;
  await saveWechatConnection(pool, cipher, userId, credentials);
  return true;
}

export async function getCloudWechatStatus(
  pool: Pool,
  userId: string,
): Promise<CloudWechatStatus> {
  const [connection, ai] = await Promise.all([
    pool.query<{
      reply_mode: CloudWechatStatus['replyMode'];
      online: boolean;
    }>(
      `SELECT reply_mode,
              last_polled_at > now() - interval '2 minutes' AS online
       FROM wechat_connections
       WHERE user_id = $1 AND status = 'active' AND revoked_at IS NULL
       LIMIT 1`,
      [userId],
    ),
    pool.query<{ ai_mode: string; providers: string[] }>(
      `SELECT account.ai_mode,
              COALESCE(array_agg(credential.provider)
                FILTER (WHERE credential.provider IS NOT NULL), '{}') AS providers
       FROM users AS account
       LEFT JOIN api_credentials AS credential
         ON credential.user_id = account.id AND credential.revoked_at IS NULL
       WHERE account.id = $1
       GROUP BY account.id`,
      [userId],
    ),
  ]);
  const row = connection.rows[0];
  const aiRow = ai.rows[0];
  const providers = aiRow?.providers ?? [];
  return {
    configured: true,
    bound: Boolean(row),
    bindingCode: null,
    expiresAt: null,
    replyMode: row?.reply_mode ?? 'first',
    gatewayOnline: row?.online === true,
    localWhisperAvailable: false,
    aiAvailable:
      aiRow?.ai_mode === 'managed' ||
      (aiRow?.ai_mode === 'bring_your_own_key' && providers.length > 0),
    visionAvailable:
      aiRow?.ai_mode === 'managed' || providers.includes('zhipu'),
  };
}

export async function updateCloudWechatReplyMode(
  pool: Pool,
  userId: string,
  replyMode: CloudWechatStatus['replyMode'],
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE wechat_connections
     SET reply_mode = $1, updated_at = now()
     WHERE user_id = $2 AND status = 'active' AND revoked_at IS NULL`,
    [replyMode, userId],
  );
  return result.rowCount === 1;
}

export async function listCloudWechatCaptures(
  pool: Pool,
  userId: string,
): Promise<Array<{
  id: string;
  content: string;
  sourceUrl: string | null;
  userContext: string | null;
  pageTitle: string | null;
  pageSite: string | null;
  pageText: string | null;
  createdAt: string;
}>> {
  const result = await pool.query<{
    id: string;
    content: string;
    source_url: string | null;
    user_context: string | null;
    source_page_title: string | null;
    source_page_site: string | null;
    source_page_text: string | null;
    created_at: Date;
  }>(
    `SELECT note.id, note.content, note.source_url, note.user_context,
            note.source_page_title, note.source_page_site,
            note.source_page_text, note.created_at
     FROM notes AS note
     WHERE note.user_id = $1 AND note.source = 'wechat'
       AND note.deleted_at IS NULL
     ORDER BY note.created_at DESC, note.id DESC
     LIMIT 100`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    sourceUrl: row.source_url,
    userContext: row.user_context,
    pageTitle: row.source_page_title,
    pageSite: row.source_page_site,
    pageText: row.source_page_text,
    createdAt: row.created_at.toISOString(),
  }));
}

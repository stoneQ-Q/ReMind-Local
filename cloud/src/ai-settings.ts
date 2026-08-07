import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';

export const AI_PROVIDERS = ['deepseek', 'zhipu'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type AiUsageMode =
  | 'disabled'
  | 'bring_your_own_key'
  | 'managed';

export type AiSettings = {
  mode: AiUsageMode;
  credentials: Array<{
    provider: AiProvider;
    maskedSuffix: string;
    updatedAt: string;
  }>;
};

export async function getAiSettings(
  pool: Pool,
  userId: string,
): Promise<AiSettings> {
  const [account, credentials] = await Promise.all([
    pool.query<{ ai_mode: AiUsageMode }>(
      `SELECT ai_mode FROM users WHERE id = $1`,
      [userId],
    ),
    pool.query<{
      provider: AiProvider;
      masked_suffix: string;
      updated_at: Date;
    }>(
      `SELECT provider, masked_suffix, updated_at
       FROM api_credentials
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY provider`,
      [userId],
    ),
  ]);
  const mode = account.rows[0]?.ai_mode;
  if (!mode) throw new Error('Account not found');
  return {
    mode,
    credentials: credentials.rows.map((row) => ({
      provider: row.provider,
      maskedSuffix: row.masked_suffix,
      updatedAt: row.updated_at.toISOString(),
    })),
  };
}

export async function updateAiMode(
  pool: Pool,
  userId: string,
  mode: AiUsageMode,
): Promise<AiSettings | null> {
  if (mode === 'bring_your_own_key') {
    const credential = await pool.query(
      `SELECT 1 FROM api_credentials
       WHERE user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [userId],
    );
    if (!credential.rowCount) return null;
  }
  await pool.query(
    `UPDATE users SET ai_mode = $1, updated_at = now() WHERE id = $2`,
    [mode, userId],
  );
  return getAiSettings(pool, userId);
}

export async function saveApiCredential(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  provider: AiProvider,
  rawApiKey: string,
): Promise<AiSettings> {
  const apiKey = rawApiKey.trim();
  if (
    apiKey.length < 12 ||
    apiKey.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(apiKey)
  ) {
    throw new InvalidApiCredentialError();
  }
  const encrypted = cipher.encrypt(apiKey, { userId, provider });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM api_credentials
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    await client.query(
      `INSERT INTO api_credentials (
         user_id,
         provider,
         encrypted_key,
         encryption_key_version,
         masked_suffix
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        provider,
        encrypted.ciphertext,
        encrypted.keyVersion,
        apiKey.slice(-4),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAiSettings(pool, userId);
}

export async function deleteApiCredential(
  pool: Pool,
  userId: string,
  provider: AiProvider,
): Promise<AiSettings> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM api_credentials
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    const remaining = await client.query(
      `SELECT 1 FROM api_credentials
       WHERE user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [userId],
    );
    if (!remaining.rowCount) {
      await client.query(
        `UPDATE users
         SET ai_mode = 'disabled', updated_at = now()
         WHERE id = $1 AND ai_mode = 'bring_your_own_key'`,
        [userId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAiSettings(pool, userId);
}

export async function loadApiCredential(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  provider: AiProvider,
): Promise<string | null> {
  const result = await pool.query<{
    encrypted_key: Buffer;
    encryption_key_version: string;
  }>(
    `SELECT encrypted_key, encryption_key_version
     FROM api_credentials
     WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL`,
    [userId, provider],
  );
  const row = result.rows[0];
  return row
    ? cipher.decrypt(
        {
          ciphertext: row.encrypted_key,
          keyVersion: row.encryption_key_version,
        },
        { userId, provider },
      )
    : null;
}

export async function rotateApiCredentials(
  pool: Pool,
  cipher: CredentialCipher,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const credentials = await client.query<{
      id: string;
      user_id: string;
      provider: AiProvider;
      encrypted_key: Buffer;
      encryption_key_version: string;
    }>(
      `SELECT id, user_id, provider, encrypted_key, encryption_key_version
       FROM api_credentials
       WHERE revoked_at IS NULL
       FOR UPDATE`,
    );
    let rotated = 0;
    for (const row of credentials.rows) {
      if (row.encryption_key_version === cipher.activeKeyVersion) continue;
      const context = { userId: row.user_id, provider: row.provider };
      const plaintext = cipher.decrypt(
        {
          ciphertext: row.encrypted_key,
          keyVersion: row.encryption_key_version,
        },
        context,
      );
      const encrypted = cipher.encrypt(plaintext, context);
      await client.query(
        `UPDATE api_credentials
         SET encrypted_key = $1,
             encryption_key_version = $2,
             updated_at = now()
         WHERE id = $3`,
        [encrypted.ciphertext, encrypted.keyVersion, row.id],
      );
      rotated += 1;
    }
    await client.query('COMMIT');
    return rotated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function isAiProvider(value: string): value is AiProvider {
  return AI_PROVIDERS.includes(value as AiProvider);
}

export function isAiUsageMode(value: unknown): value is AiUsageMode {
  return (
    value === 'disabled' ||
    value === 'bring_your_own_key' ||
    value === 'managed'
  );
}

export class InvalidApiCredentialError extends Error {
  constructor() {
    super('Invalid API credential');
  }
}

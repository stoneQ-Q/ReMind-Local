import type { Pool, PoolClient } from 'pg';

import {
  createOpaqueSecret,
  createRecoveryCode,
  hashSecret,
  normalizeRecoveryCode,
} from './secrets.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DevicePlatform = 'android' | 'ios' | 'unknown';

export type DeviceRegistration = {
  platform: DevicePlatform;
  displayName: string | null;
  appVersion: string | null;
};

export type AuthSession = {
  userId: string;
  deviceId: string;
  deviceSecret: string;
  accessToken: string;
  accessTokenExpiresAt: string;
};

export type CreatedAnonymousAccount = AuthSession & {
  recoveryCode: string;
};

export type AuthenticatedUser = {
  userId: string;
  deviceId: string;
  aiMode: 'disabled' | 'bring_your_own_key' | 'managed';
  createdAt: string;
};

export async function createAnonymousAccount(
  pool: Pool,
  registration: DeviceRegistration,
): Promise<CreatedAnonymousAccount> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      `INSERT INTO users DEFAULT VALUES RETURNING id`,
    );
    const userId = requiredRow(user.rows[0], 'user');
    await client.query(
      `INSERT INTO billing_accounts (user_id) VALUES ($1)`,
      [userId],
    );

    const recoveryCode = createRecoveryCode();
    await client.query(
      `INSERT INTO recovery_credentials (user_id, secret_hash)
       VALUES ($1, $2)`,
      [userId, hashSecret(normalizeRecoveryCode(recoveryCode))],
    );

    const session = await createDeviceSession(client, userId, registration);
    await client.query('COMMIT');
    return { ...session, recoveryCode };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverAnonymousAccount(
  pool: Pool,
  recoveryCode: string,
  registration: DeviceRegistration,
): Promise<AuthSession | null> {
  const normalized = normalizeRecoveryCode(recoveryCode);
  if (normalized.length !== 34 || !normalized.startsWith('RM')) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const credential = await client.query<{ user_id: string }>(
      `SELECT user_id
       FROM recovery_credentials
       WHERE secret_hash = $1
         AND revoked_at IS NULL
       FOR UPDATE`,
      [hashSecret(normalized)],
    );
    const userId = credential.rows[0]?.user_id;
    if (!userId) {
      await client.query('ROLLBACK');
      return null;
    }

    const session = await createDeviceSession(client, userId, registration);
    await client.query(
      `UPDATE recovery_credentials
       SET last_used_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function refreshDeviceSession(
  pool: Pool,
  deviceId: string,
  deviceSecret: string,
): Promise<AuthSession | null> {
  if (!deviceId || !deviceSecret.startsWith('rmd_')) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await client.query<{ user_id: string }>(
      `SELECT device.user_id
       FROM devices AS device
       JOIN users AS account ON account.id = device.user_id
       WHERE device.id = $1
         AND device.secret_hash = $2
         AND device.revoked_at IS NULL
         AND account.status = 'active'
       FOR UPDATE OF device`,
      [deviceId, hashSecret(deviceSecret)],
    );
    const userId = device.rows[0]?.user_id;
    if (!userId) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `UPDATE user_sessions
       SET revoked_at = now()
       WHERE user_id = $1
         AND device_id = $2
         AND revoked_at IS NULL`,
      [userId, deviceId],
    );
    await client.query(
      `UPDATE devices SET last_seen_at = now()
       WHERE user_id = $1 AND id = $2`,
      [userId, deviceId],
    );
    const session = await createSession(
      client,
      userId,
      deviceId,
      deviceSecret,
    );
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateAccessToken(
  pool: Pool,
  authorization: string | undefined,
): Promise<AuthenticatedUser | null> {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!token?.startsWith('rms_')) return null;

  const result = await pool.query<{
    user_id: string;
    device_id: string;
    ai_mode: AuthenticatedUser['aiMode'];
    created_at: Date;
  }>(
    `UPDATE user_sessions AS session
     SET last_seen_at = now()
     FROM users AS account, devices AS device
     WHERE session.token_hash = $1
       AND session.user_id = account.id
       AND session.user_id = device.user_id
       AND session.device_id = device.id
       AND session.expires_at > now()
       AND session.revoked_at IS NULL
       AND device.revoked_at IS NULL
       AND account.status = 'active'
     RETURNING
       session.user_id,
       session.device_id,
       account.ai_mode,
       account.created_at`,
    [hashSecret(token)],
  );
  const row = result.rows[0];
  return row
    ? {
        userId: row.user_id,
        deviceId: row.device_id,
        aiMode: row.ai_mode,
        createdAt: row.created_at.toISOString(),
      }
    : null;
}

export async function listUserDevices(
  pool: Pool,
  userId: string,
  currentDeviceId: string,
): Promise<
  Array<{
    id: string;
    displayName: string | null;
    platform: DevicePlatform;
    appVersion: string | null;
    current: boolean;
    createdAt: string;
    lastSeenAt: string;
  }>
> {
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    platform: DevicePlatform;
    app_version: string | null;
    created_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT id, display_name, platform, app_version, created_at, last_seen_at
     FROM devices
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    platform: row.platform,
    appVersion: row.app_version,
    current: row.id === currentDeviceId,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  }));
}

export async function revokeUserDevice(
  pool: Pool,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revoked = await client.query(
      `UPDATE devices
       SET revoked_at = now()
       WHERE user_id = $1
         AND id = $2
         AND revoked_at IS NULL
       RETURNING id`,
      [userId, deviceId],
    );
    if (revoked.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE user_sessions
       SET revoked_at = now()
       WHERE user_id = $1
         AND device_id = $2
         AND revoked_at IS NULL`,
      [userId, deviceId],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createDeviceSession(
  client: PoolClient,
  userId: string,
  registration: DeviceRegistration,
): Promise<AuthSession> {
  const deviceSecret = createOpaqueSecret('rmd');
  const device = await client.query<{ id: string }>(
    `INSERT INTO devices (
       user_id,
       secret_hash,
       display_name,
       platform,
       app_version
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      userId,
      hashSecret(deviceSecret),
      registration.displayName,
      registration.platform,
      registration.appVersion,
    ],
  );
  const deviceId = requiredRow(device.rows[0], 'device');
  return createSession(client, userId, deviceId, deviceSecret);
}

async function createSession(
  client: PoolClient,
  userId: string,
  deviceId: string,
  deviceSecret: string,
): Promise<AuthSession> {
  const accessToken = createOpaqueSecret('rms');
  const accessTokenExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await client.query(
    `INSERT INTO user_sessions (
       user_id,
       device_id,
       token_hash,
       expires_at
     )
     VALUES ($1, $2, $3, $4)`,
    [userId, deviceId, hashSecret(accessToken), accessTokenExpiresAt],
  );
  return {
    userId,
    deviceId,
    deviceSecret,
    accessToken,
    accessTokenExpiresAt,
  };
}

function requiredRow(
  row: { id: string } | undefined,
  resource: string,
): string {
  if (!row) throw new Error(`Unable to create ${resource}`);
  return row.id;
}

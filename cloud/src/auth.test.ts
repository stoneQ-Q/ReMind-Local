import { describe, expect, it, vi } from 'vitest';

import { authenticateAccessToken, createAnonymousAccount } from './auth.js';

describe('cloud access token authentication', () => {
  it('refreshes both session and device activity timestamps', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toContain('UPDATE user_sessions AS session');
      expect(sql).toContain('UPDATE devices AS device');
      expect(sql).toContain('SET last_seen_at = now()');
      expect(values).toHaveLength(1);
      return {
        rows: [
          {
            user_id: 'user-1',
            device_id: 'device-1',
            ai_mode: 'bring_your_own_key',
            created_at: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      };
    });

    await expect(
      authenticateAccessToken(
        { query } as never,
        'Bearer rms_valid_access_token',
      ),
    ).resolves.toEqual({
      userId: 'user-1',
      deviceId: 'device-1',
      aiMode: 'bring_your_own_key',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('consumer account registration', () => {
  it('atomically starts managed mode with a gift ledger entry', async () => {
    const statements: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes('INSERT INTO users')) {
          return { rows: [{ id: 'user-1' }] };
        }
        if (sql.includes('INSERT INTO billing_accounts')) {
          return { rows: [{ id: 'billing-1' }] };
        }
        if (sql.includes('INSERT INTO devices')) {
          return { rows: [{ id: 'device-1' }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    const account = await createAnonymousAccount(
      pool as never,
      {
        platform: 'android',
        displayName: '这台 Android 设备',
        appVersion: '1.0.2',
      },
      { aiMode: 'managed', starterCreditMicros: 2_000_000n },
    );

    expect(account.userId).toBe('user-1');
    expect(account.deviceId).toBe('device-1');
    expect(
      statements.find(({ sql }) => sql.includes('INSERT INTO users'))?.values,
    ).toEqual(['managed']);
    expect(
      statements.find(({ sql }) =>
        sql.includes('INSERT INTO billing_accounts'),
      )?.values,
    ).toEqual(['user-1', '2000000']);
    const gift = statements.find(({ sql }) =>
      sql.includes('consumer_starter_credit'),
    );
    expect(gift?.values).toEqual([
      'user-1',
      'billing-1',
      '2000000',
      'consumer-starter:user-1',
    ]);
    expect(statements.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

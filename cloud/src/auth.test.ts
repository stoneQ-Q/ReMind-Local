import { describe, expect, it, vi } from 'vitest';

import { authenticateAccessToken } from './auth.js';

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

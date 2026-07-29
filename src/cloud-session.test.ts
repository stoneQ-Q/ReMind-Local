import { describe, expect, it } from 'vitest';

import {
  CLOUD_SESSION_REFRESH_WINDOW_MS,
  shouldRefreshCloudSession,
  type CloudSession,
} from './cloud-session';

const now = Date.parse('2026-07-29T00:00:00.000Z');

function session(expiresAtMs: number): CloudSession {
  return {
    userId: 'user-1',
    deviceId: 'device-1',
    deviceSecret: 'rmd_secret',
    accessToken: 'rms_token',
    accessTokenExpiresAt: new Date(expiresAtMs).toISOString(),
  };
}

describe('cloud session renewal', () => {
  it('keeps a session with more than seven days remaining', () => {
    expect(
      shouldRefreshCloudSession(
        session(now + CLOUD_SESSION_REFRESH_WINDOW_MS + 1),
        now,
      ),
    ).toBe(false);
  });

  it('renews a session when seven days or less remain', () => {
    expect(
      shouldRefreshCloudSession(
        session(now + CLOUD_SESSION_REFRESH_WINDOW_MS),
        now,
      ),
    ).toBe(true);
  });

  it('renews expired or malformed sessions', () => {
    expect(shouldRefreshCloudSession(session(now - 1), now)).toBe(true);
    expect(
      shouldRefreshCloudSession(
        { ...session(now), accessTokenExpiresAt: 'invalid' },
        now,
      ),
    ).toBe(true);
  });
});

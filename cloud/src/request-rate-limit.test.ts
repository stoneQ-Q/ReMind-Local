import { describe, expect, it } from 'vitest';

import { RequestRateLimiter } from './request-rate-limit.js';

describe('public API request rate limiter', () => {
  it('limits anonymous registration per client and resets the window', () => {
    let now = 1_000;
    const limiter = new RequestRateLimiter(() => now);
    for (let index = 0; index < 5; index += 1) {
      expect(
        limiter.check('203.0.113.8', '/api/v1/auth/register'),
      ).toEqual({ allowed: true });
    }
    expect(
      limiter.check('203.0.113.8', '/api/v1/auth/register'),
    ).toEqual({
      allowed: false,
      retryAfterSeconds: 3_600,
    });
    expect(
      limiter.check('203.0.113.9', '/api/v1/auth/register'),
    ).toEqual({ allowed: true });

    now += 60 * 60_000;
    expect(
      limiter.check('203.0.113.8', '/api/v1/auth/register'),
    ).toEqual({ allowed: true });
  });

  it('uses separate stricter windows for recovery and refresh', () => {
    const limiter = new RequestRateLimiter(() => 10_000);
    for (let index = 0; index < 10; index += 1) {
      expect(
        limiter.check('203.0.113.8', '/api/v1/auth/recover').allowed,
      ).toBe(true);
    }
    expect(
      limiter.check('203.0.113.8', '/api/v1/auth/recover').allowed,
    ).toBe(false);
    expect(
      limiter.check('203.0.113.8', '/api/v1/auth/refresh').allowed,
    ).toBe(true);
  });

  it('strictly limits public WeChat binding claims', () => {
    const limiter = new RequestRateLimiter(() => 10_000);
    for (let index = 0; index < 10; index += 1) {
      expect(
        limiter.check('203.0.113.8', '/api/v1/wechat/bindings/claim').allowed,
      ).toBe(true);
    }
    expect(
      limiter.check('203.0.113.8', '/api/v1/wechat/bindings/claim').allowed,
    ).toBe(false);
  });
});

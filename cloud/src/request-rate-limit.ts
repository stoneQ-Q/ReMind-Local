import type { IncomingMessage } from 'node:http';

type RateLimitRule = {
  scope: string;
  maximumRequests: number;
  windowMilliseconds: number;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const MAX_TRACKED_WINDOWS = 20_000;
const GENERAL_RULE: RateLimitRule = {
  scope: 'general',
  maximumRequests: 1_200,
  windowMilliseconds: 60_000,
};
const AUTH_RULES = new Map<string, RateLimitRule>([
  [
    '/api/v1/auth/register',
    {
      scope: 'auth_register',
      maximumRequests: 5,
      windowMilliseconds: 60 * 60_000,
    },
  ],
  [
    '/api/v1/auth/recover',
    {
      scope: 'auth_recover',
      maximumRequests: 10,
      windowMilliseconds: 15 * 60_000,
    },
  ],
  [
    '/api/v1/auth/refresh',
    {
      scope: 'auth_refresh',
      maximumRequests: 60,
      windowMilliseconds: 5 * 60_000,
    },
  ],
  [
    '/api/v1/wechat/bindings/claim',
    {
      scope: 'wechat_binding_claim',
      maximumRequests: 10,
      windowMilliseconds: 15 * 60_000,
    },
  ],
  [
    '/api/v1/wechat/login',
    {
      scope: 'wechat_login_start',
      maximumRequests: 10,
      windowMilliseconds: 60 * 60_000,
    },
  ],
  [
    '/api/v1/wechat/login/check',
    {
      scope: 'wechat_login_check',
      maximumRequests: 120,
      windowMilliseconds: 15 * 60_000,
    },
  ],
]);

export class RequestRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  check(clientAddress: string, requestUrl: string): RateLimitDecision {
    const now = this.now();
    const general = this.consume(clientAddress, GENERAL_RULE, now);
    if (!general.allowed) return general;
    const authRule = AUTH_RULES.get(requestUrl);
    return authRule
      ? this.consume(clientAddress, authRule, now)
      : { allowed: true };
  }

  private consume(
    clientAddress: string,
    rule: RateLimitRule,
    now: number,
  ): RateLimitDecision {
    const key = `${rule.scope}:${clientAddress}`;
    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      this.ensureCapacity(now);
      this.entries.set(key, {
        count: 1,
        resetAt: now + rule.windowMilliseconds,
      });
      return { allowed: true };
    }
    if (existing.count >= rule.maximumRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.resetAt - now) / 1_000),
        ),
      };
    }
    existing.count += 1;
    return { allowed: true };
  }

  private ensureCapacity(now: number): void {
    if (this.entries.size < MAX_TRACKED_WINDOWS) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    if (this.entries.size < MAX_TRACKED_WINDOWS) return;
    const oldest = this.entries.keys().next().value as string | undefined;
    if (oldest) this.entries.delete(oldest);
  }
}

export function requestClientAddress(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const firstForwarded =
    typeof forwarded === 'string'
      ? forwarded.split(',', 1)[0]?.trim()
      : forwarded?.[0]?.split(',', 1)[0]?.trim();
  return normalizeAddress(
    firstForwarded || request.socket.remoteAddress || 'unknown',
  );
}

function normalizeAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/^::ffff:(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(normalized)) {
    return normalized.slice('::ffff:'.length);
  }
  if (
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(normalized) ||
    /^[0-9a-f:]{2,64}$/.test(normalized)
  ) {
    return normalized;
  }
  return 'unknown';
}

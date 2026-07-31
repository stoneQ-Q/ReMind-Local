import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./migrations/0013_wechat_binding_codes.sql', import.meta.url),
  'utf8',
);

describe('WeChat cloud binding codes', () => {
  it('stores only a hashed, expiring, single-use code per user', () => {
    expect(migration).toContain('code_hash TEXT NOT NULL UNIQUE');
    expect(migration).not.toMatch(/binding_code\s+TEXT/i);
    expect(migration).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('claimed_at TIMESTAMPTZ');
    expect(migration).toContain('wechat_binding_codes_active_user_idx');
  });
});

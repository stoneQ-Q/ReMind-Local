import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./migrations/0005_async_job_executor.sql', import.meta.url),
  'utf8',
);

describe('async job executor migration', () => {
  it('adds leases, cancellation, timeout, and retry limits', () => {
    expect(migration).toContain('max_attempts INTEGER NOT NULL');
    expect(migration).toContain('timeout_seconds INTEGER NOT NULL');
    expect(migration).toContain('lease_token UUID');
    expect(migration).toContain('lease_expires_at TIMESTAMPTZ');
    expect(migration).toContain('cancel_requested_at TIMESTAMPTZ');
  });

  it('keeps an immutable task input and a separate attempt history', () => {
    expect(migration).toContain('CREATE TABLE job_attempts');
    expect(migration).toContain('attempt_number INTEGER NOT NULL');
    expect(migration).toContain("'lease_expired'");
    expect(migration).not.toMatch(/UPDATE\s+jobs[\s\S]*input_json/i);
  });

  it('persists per-user scheduling fairness', () => {
    expect(migration).toContain('CREATE TABLE worker_user_fairness');
    expect(migration).toContain('last_claimed_at TIMESTAMPTZ');
  });
});

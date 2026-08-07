import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./migrations/0003_billing_controls.sql', import.meta.url),
  'utf8',
);

describe('billing controls migration', () => {
  it('records balance and reservation deltas plus after-operation snapshots', () => {
    expect(migration).toContain('balance_delta_micros BIGINT NOT NULL');
    expect(migration).toContain('reserved_delta_micros BIGINT NOT NULL');
    expect(migration).toContain('balance_after_micros BIGINT NOT NULL');
    expect(migration).toContain('reserved_after_micros BIGINT NOT NULL');
  });

  it('defines job, user, and platform hard limits', () => {
    expect(migration).toContain('max_job_cost_micros BIGINT NOT NULL');
    expect(migration).toContain('daily_limit_micros BIGINT NOT NULL');
    expect(migration).toContain('monthly_limit_micros BIGINT NOT NULL');
    expect(migration).toContain('platform_daily_limit_micros BIGINT NOT NULL');
    expect(migration).toContain('platform_monthly_limit_micros BIGINT NOT NULL');
  });

  it('keeps every after-operation snapshot nonnegative', () => {
    expect(migration).toContain('CHECK (balance_after_micros >= 0)');
    expect(migration).toContain('reserved_after_micros >= 0');
    expect(migration).toContain(
      'reserved_after_micros <= balance_after_micros',
    );
  });
});

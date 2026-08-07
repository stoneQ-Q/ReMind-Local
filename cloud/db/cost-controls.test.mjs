import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    './migrations/0004_cost_confirmation_and_provider_circuit.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('cost confirmation and provider circuit migration', () => {
  it('requires an expiring quote state for high-cost confirmation', () => {
    expect(migration).toContain(
      'high_cost_confirmation_threshold_micros BIGINT NOT NULL',
    );
    expect(migration).toContain(
      'confirmation_required BOOLEAN NOT NULL DEFAULT false',
    );
    expect(migration).toContain('confirmed_at TIMESTAMPTZ');
    expect(migration).toContain('quote_expires_at TIMESTAMPTZ');
  });

  it('tracks provider pauses and creates durable operational alerts', () => {
    expect(migration).toContain('CREATE TABLE provider_health');
    expect(migration).toContain("CHECK (status IN ('active', 'paused'))");
    expect(migration).toContain('CREATE TABLE operational_alerts');
    expect(migration).toContain("'provider_auto_paused'");
  });
});

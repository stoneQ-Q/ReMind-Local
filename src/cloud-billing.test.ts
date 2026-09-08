import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cloud-api', () => ({
  CloudApiRequestError: class CloudApiRequestError extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
    ) {
      super(code);
    }
  },
  requestCloudJson: vi.fn(),
}));

import { requestCloudJson } from './cloud-api';
import {
  type CloudLedgerEntry,
  formatCnyMicros,
  formatYiliMicros,
  getCloudBillingOverview,
  simplifyConsumerLedger,
} from './cloud-billing';

const account = {
  currency: 'CNY',
  balanceMicros: '12345678',
  reservedMicros: '1200000',
  availableMicros: '11145678',
  dailyLimitMicros: '10000000',
  monthlyLimitMicros: '100000000',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

const entry: CloudLedgerEntry = {
  id: 'entry-1',
  jobId: null,
  kind: 'top_up',
  amountMicros: '12345678',
  balanceDeltaMicros: '12345678',
  reservedDeltaMicros: '0',
  balanceAfterMicros: '12345678',
  reservedAfterMicros: '0',
  source: 'gift',
  createdAt: '2026-07-30T00:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('cloud billing client', () => {
  it('loads the account and a bounded, typed ledger', async () => {
    vi.mocked(requestCloudJson)
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce({ entries: [entry] });

    await expect(getCloudBillingOverview()).resolves.toEqual({
      account,
      entries: [entry],
    });
    expect(requestCloudJson).toHaveBeenNthCalledWith(1, 'billing/account');
    expect(requestCloudJson).toHaveBeenNthCalledWith(2, 'billing/ledger');
  });

  it('rejects malformed amounts and unknown internal metadata', async () => {
    vi.mocked(requestCloudJson)
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce({
        entries: [
          {
            ...entry,
            balanceDeltaMicros: '12.34',
            source: 'internal-secret',
          },
        ],
      });

    await expect(getCloudBillingOverview()).rejects.toThrow(
      'invalid_billing_ledger_response',
    );
  });

  it('rejects an account whose available balance does not reconcile', async () => {
    vi.mocked(requestCloudJson)
      .mockResolvedValueOnce({ ...account, availableMicros: '99999999' })
      .mockResolvedValueOnce({ entries: [] });

    await expect(getCloudBillingOverview()).rejects.toThrow(
      'invalid_billing_account_response',
    );
  });

  it('formats integer micros without floating point rounding', () => {
    expect(formatCnyMicros('0')).toBe('¥0.00');
    expect(formatCnyMicros('1')).toBe('¥0.000001');
    expect(formatCnyMicros('1200000')).toBe('¥1.20');
    expect(formatCnyMicros('1234567890')).toBe('¥1,234.56789');
    expect(formatCnyMicros('-2500000', true)).toBe('-¥2.50');
    expect(formatCnyMicros('2500000', true)).toBe('+¥2.50');
  });

  it('formats consumer usage as branded yili without currency', () => {
    expect(formatYiliMicros('0')).toBe('0 忆粒');
    expect(formatYiliMicros('10000')).toBe('1 忆粒');
    expect(formatYiliMicros('12345')).toBe('1.23 忆粒');
    expect(formatYiliMicros('2000000')).toBe('200 忆粒');
    expect(formatYiliMicros('-12500', true)).toBe('-1.25 忆粒');
    expect(formatYiliMicros('12500', true)).toBe('+1.25 忆粒');
  });

  it('shows one simple consumer activity after a reserved job settles', () => {
    const settled = {
      ...entry,
      id: 'settle-1',
      jobId: 'job-1',
      kind: 'settle' as const,
      amountMicros: '10247',
      balanceDeltaMicros: '-10247',
      reservedDeltaMicros: '-10247',
      balanceAfterMicros: '1989753',
      reservedAfterMicros: '104633',
      source: null,
    };
    const activities = simplifyConsumerLedger([
      settled,
      {
        ...settled,
        id: 'release-1',
        kind: 'release',
        amountMicros: '104633',
        balanceDeltaMicros: '0',
        reservedDeltaMicros: '-104633',
        reservedAfterMicros: '0',
      },
      {
        ...settled,
        id: 'reserve-1',
        kind: 'reserve',
        amountMicros: '114880',
        balanceDeltaMicros: '0',
        reservedDeltaMicros: '114880',
        balanceAfterMicros: '2000000',
        reservedAfterMicros: '114880',
      },
      entry,
    ]);

    expect(activities.map((item) => item.id)).toEqual(['settle-1', 'entry-1']);
  });

  it('keeps an active consumer reservation visible until it finishes', () => {
    const reserve = {
      ...entry,
      id: 'reserve-1',
      jobId: 'job-1',
      kind: 'reserve' as const,
      source: null,
    };
    expect(simplifyConsumerLedger([reserve])).toEqual([reserve]);
  });
});

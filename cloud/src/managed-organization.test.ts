import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createManagedJobQuote: vi.fn(),
  reserveJobCost: vi.fn(),
  settleJobCost: vi.fn(),
  releaseJobCost: vi.fn(),
}));

vi.mock('./job-quotes.js', () => ({
  createManagedJobQuote: mocks.createManagedJobQuote,
}));
vi.mock('./billing.js', () => ({
  reserveJobCost: mocks.reserveJobCost,
  settleJobCost: mocks.settleJobCost,
  releaseJobCost: mocks.releaseJobCost,
}));

import { runManagedOrganization } from './managed-organization.js';

const catalog = {
  zhipuVisionPerImageMicros: 1n,
  zhipuAsrPerMinuteMicros: 1n,
  deepseekInputPerMillionTokensMicros: 1_000_000n,
  deepseekOutputPerMillionTokensMicros: 2_000_000n,
};

describe('managed organization billing', () => {
  it('reserves before execution and settles from provider usage', async () => {
    mocks.createManagedJobQuote.mockResolvedValue({ jobId: 'billing-job-1' });
    mocks.reserveJobCost.mockResolvedValue({});
    mocks.settleJobCost.mockResolvedValue({});
    const run = vi.fn(async (execution) => {
      execution.onUsage?.({ promptTokens: 100, completionTokens: 25 });
      return { ok: true };
    });

    await expect(
      runManagedOrganization({
        pool: {} as never,
        userId: 'user-1',
        operation: 'organize',
        body: { sources: [{ content: 'hello' }] },
        priceCatalog: catalog,
        managedCredentials: { deepseek: 'platform-key' },
        run,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.reserveJobCost).toHaveBeenCalledBefore(run);
    expect(mocks.settleJobCost).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'billing-job-1',
      150n,
      expect.stringContaining('managed-organization:organize:'),
    );
  });

  it('releases the full reservation when the provider fails', async () => {
    mocks.createManagedJobQuote.mockResolvedValue({ jobId: 'billing-job-2' });
    mocks.reserveJobCost.mockResolvedValue({});
    mocks.releaseJobCost.mockResolvedValue({});
    const providerError = new Error('provider failed');

    await expect(
      runManagedOrganization({
        pool: {} as never,
        userId: 'user-2',
        operation: 'memory-question',
        body: { question: 'why' },
        priceCatalog: catalog,
        managedCredentials: { deepseek: 'platform-key' },
        run: async () => {
          throw providerError;
        },
      }),
    ).rejects.toBe(providerError);

    expect(mocks.releaseJobCost).toHaveBeenCalledWith(
      expect.anything(),
      'user-2',
      'billing-job-2',
      'failed',
      expect.stringContaining('managed-organization:memory-question:'),
    );
  });
});

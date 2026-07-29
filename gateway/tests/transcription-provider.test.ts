import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cloudCostLimitMicros,
  createTranscriptionProvider,
  requiresCloudCostApproval,
} from '../src/transcription-provider.js';

describe('createTranscriptionProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the current authenticated Zhipu cloud path as the default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ text: '转写结果' }),
    );
    const provider = createTranscriptionProvider({
      apiBaseUrl: 'http://127.0.0.1:8787',
      credentials: {
        connectorId: 'connector-id',
        connectorSecret: 'connector-secret',
        kind: 'weixin-ilink',
      },
    });

    expect(provider.id).toBe('zhipu-cloud');
    expect(provider.estimateCostMicros(382)).toBe(382_000);
    expect(await provider.transcribe(new Uint8Array([1, 2, 3]))).toBe(
      '转写结果',
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/audio-transcriptions',
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer connector-secret',
    });
  });

  it('uses a ¥0.30 default cloud limit and only pauses above it', () => {
    expect(cloudCostLimitMicros(undefined)).toBe(300_000);
    expect(cloudCostLimitMicros('0.8')).toBe(800_000);
    expect(
      requiresCloudCostApproval({
        estimatedCostMicros: 300_000,
        costLimitMicros: 300_000,
        approved: false,
      }),
    ).toBe(false);
    expect(
      requiresCloudCostApproval({
        estimatedCostMicros: 300_001,
        costLimitMicros: 300_000,
        approved: false,
      }),
    ).toBe(true);
    expect(
      requiresCloudCostApproval({
        estimatedCostMicros: 900_000,
        costLimitMicros: 300_000,
        approved: true,
      }),
    ).toBe(false);
    expect(
      requiresCloudCostApproval({
        estimatedCostMicros: null,
        costLimitMicros: 300_000,
        approved: false,
      }),
    ).toBe(true);
  });
});

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { WhisperFirstByokMediaProcessingProvider } from './byok-media-provider.js';
import type { CredentialCipher } from './credential-cipher.js';
import type { WhisperMediaClient } from './whisper-media-client.js';

const signal = new AbortController().signal;
const context = {
  userId: '8f3f4138-d318-49a4-9814-1d67176ca1a7',
  reservedCostMicros: 0n,
  durationSeconds: 28,
};

describe('Whisper-first BYOK media provider', () => {
  it('uses server Whisper without querying for a Zhipu credential', async () => {
    const query = vi.fn();
    const provider = new WhisperFirstByokMediaProcessingProvider(
      { query } as unknown as Pool,
      {} as CredentialCipher,
      {
        transcribeAudio: vi.fn(async () => ({
          transcript: '服务器本地转写',
          model: 'whisper-small-q5_1' as const,
        })),
      } as unknown as WhisperMediaClient,
    );

    await expect(
      provider.transcribeAudio(
        Buffer.from('audio'),
        signal,
        context,
        'audio/mpeg',
      ),
    ).resolves.toEqual({ output: '服务器本地转写', actualCostMicros: 0n });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the Whisper error when no optional Zhipu fallback exists', async () => {
    const query = vi.fn(async () => ({ rows: [{ present: false }] }));
    const provider = new WhisperFirstByokMediaProcessingProvider(
      { query } as unknown as Pool,
      {} as CredentialCipher,
      {
        transcribeAudio: vi.fn(async () => {
          throw new Error('whisper_unavailable');
        }),
      } as unknown as WhisperMediaClient,
    );

    await expect(
      provider.transcribeAudio(
        Buffer.from('audio'),
        signal,
        context,
        'audio/mpeg',
      ),
    ).rejects.toThrow('whisper_unavailable');
    expect(query).toHaveBeenCalledOnce();
  });
});

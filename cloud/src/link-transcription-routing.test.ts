import { describe, expect, it } from 'vitest';

import { selectLinkTranscriptionProvider } from './link-processing.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const ordinaryId = '8f3f4138-d318-49a4-9814-1d67176ca1a7';

function select(
  userId: string,
  overrides: Partial<
    Parameters<typeof selectLinkTranscriptionProvider>[0]
  > = {},
) {
  return selectLinkTranscriptionProvider({
    userId,
    aiMode: 'managed',
    supportedMedia: true,
    paraformerAvailable: true,
    managedPricingAvailable: true,
    managedDurationAvailable: true,
    whisperAvailable: true,
    serverWhisperUserIds: new Set([ownerId]),
    ...overrides,
  });
}

describe('link transcription routing', () => {
  it('keeps server Whisper exclusive to the private account allowlist', () => {
    expect(select(ownerId)).toBe('whisper');
    expect(select(ordinaryId)).toBe('dashscope');
  });

  it('fails closed when managed API prerequisites are absent', () => {
    expect(select(ordinaryId, { managedPricingAvailable: false })).toBe(
      'unavailable',
    );
    expect(select(ordinaryId, { managedDurationAvailable: false })).toBe(
      'unavailable',
    );
    expect(select(ordinaryId, { supportedMedia: false })).toBe('legacy');
  });

  it('does not spend the platform key for a BYOK cloud account', () => {
    expect(select(ordinaryId, { aiMode: 'bring_your_own_key' })).toBe(
      'legacy',
    );
  });
});

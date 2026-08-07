import { afterEach, describe, expect, it } from 'vitest';

import { xiaoyuzhouTranscriptionEnabled } from './config.js';

const originalValue = process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;
  } else {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = originalValue;
  }
});

describe('xiaoyuzhouTranscriptionEnabled', () => {
  it('is paused by default', () => {
    delete process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;

    expect(xiaoyuzhouTranscriptionEnabled()).toBe(false);
  });

  it('can be explicitly enabled', () => {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = 'true';

    expect(xiaoyuzhouTranscriptionEnabled()).toBe(true);
  });

  it('rejects ambiguous values', () => {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = 'yes';

    expect(() => xiaoyuzhouTranscriptionEnabled()).toThrow(
      'REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED must be true or false',
    );
  });
});

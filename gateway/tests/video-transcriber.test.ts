import { describe, expect, it } from 'vitest';

import { formatTimestamp } from '../src/video-transcriber.js';

describe('formatTimestamp', () => {
  it('formats segment offsets without wrapping after one hour', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(84)).toBe('01:24');
    expect(formatTimestamp(3_661)).toBe('61:01');
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractVideoAudioSegments,
  formatMediaTimestamp,
  probeMediaDurationSeconds,
} from './video-audio-segments.js';

describe('video audio segments', () => {
  it('formats stable timestamps', () => {
    expect(formatMediaTimestamp(0)).toBe('00:00');
    expect(formatMediaTimestamp(28)).toBe('00:28');
    expect(formatMediaTimestamp(84)).toBe('01:24');
  });

  it('uses a local source path and returns ordered private segments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-fake-ffmpeg-'));
    const executable = join(directory, 'ffmpeg');
    await writeFile(
      executable,
      `#!/bin/sh
output=""
for item in "$@"; do output="$item"; done
first=$(printf '%s' "$output" | sed 's/%03d/000/')
second=$(printf '%s' "$output" | sed 's/%03d/001/')
printf 'first-segment' > "$first"
printf 'second-segment' > "$second"
`,
      { mode: 0o700 },
    );
    try {
      const segments = await extractVideoAudioSegments(
        join(directory, 'source.mp4'),
        new AbortController().signal,
        executable,
      );
      expect(
        segments.map((segment) => [
          segment.sequenceNumber,
          segment.startSeconds,
          segment.content.toString(),
        ]),
      ).toEqual([
        [0, 0, 'first-segment'],
        [1, 28, 'second-segment'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('honors cancellation before spawning ffmpeg', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractVideoAudioSegments('/private/source.mp4', controller.signal),
    ).rejects.toThrow('job_cancelled');
  });

  it('rounds trusted ffprobe duration upward and rejects invalid output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-fake-ffprobe-'));
    const valid = join(directory, 'valid-ffprobe');
    const invalid = join(directory, 'invalid-ffprobe');
    await writeFile(valid, '#!/bin/sh\nprintf "61.2\\n"\n', { mode: 0o700 });
    await writeFile(invalid, '#!/bin/sh\nprintf "unknown\\n"\n', {
      mode: 0o700,
    });
    try {
      await expect(
        probeMediaDurationSeconds(
          join(directory, 'source.mp3'),
          new AbortController().signal,
          valid,
        ),
      ).resolves.toBe(62);
      await expect(
        probeMediaDurationSeconds(
          join(directory, 'source.mp3'),
          new AbortController().signal,
          invalid,
        ),
      ).rejects.toThrow('invalid_media_duration');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

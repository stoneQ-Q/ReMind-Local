import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VIDEO_SEGMENT_SECONDS = 28;
const MAX_SEGMENTS = 800;
const MAX_SEGMENT_BYTES = 5_000_000;

export type ExtractedAudioSegment = {
  sequenceNumber: number;
  startSeconds: number;
  content: Buffer;
};

export async function extractVideoAudioSegments(
  sourcePath: string,
  signal: AbortSignal,
  executable = 'ffmpeg',
): Promise<ExtractedAudioSegment[]> {
  const directory = await mkdtemp(join(tmpdir(), 'remind-media-segments-'));
  try {
    await runFfmpeg(
      executable,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '32k',
        '-f',
        'segment',
        '-segment_time',
        String(VIDEO_SEGMENT_SECONDS),
        '-reset_timestamps',
        '1',
        join(directory, 'segment-%03d.mp3'),
      ],
      signal,
    );
    const names = (await readdir(directory))
      .filter((name) => /^segment-\d{3}\.mp3$/.test(name))
      .sort();
    if (names.length < 1) throw new Error('video_audio_not_found');
    if (names.length > MAX_SEGMENTS) throw new Error('video_too_many_segments');
    const segments: ExtractedAudioSegment[] = [];
    for (let index = 0; index < names.length; index += 1) {
      throwIfAborted(signal);
      const content = await readFile(join(directory, names[index] ?? ''));
      if (content.byteLength < 1 || content.byteLength > MAX_SEGMENT_BYTES) {
        throw new Error('invalid_video_audio_segment');
      }
      segments.push({
        sequenceNumber: index,
        startSeconds: index * VIDEO_SEGMENT_SECONDS,
        content,
      });
    }
    return segments;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function probeMediaDurationSeconds(
  sourcePath: string,
  signal: AbortSignal,
  executable = 'ffprobe',
): Promise<number> {
  const output = await runProcess(
    executable,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      sourcePath,
    ],
    signal,
  );
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > 21_600) {
    throw new Error('invalid_media_duration');
  }
  return Math.ceil(duration);
}

export function formatMediaTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function runFfmpeg(
  executable: string,
  arguments_: string[],
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(executable, arguments_, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let settled = false;
    let errorText = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(new Error('job_cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errorText = (errorText + chunk).slice(-1_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg_failed_${code ?? 'unknown'}:${safeError(errorText)}`));
    });
  });
}

function runProcess(
  executable: string,
  arguments_: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(executable, arguments_, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let output = '';
    let errorText = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(output);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(new Error('job_cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output = (output + chunk).slice(-1_000);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errorText = (errorText + chunk).slice(-1_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish();
      else {
        finish(
          new Error(
            `ffprobe_failed_${code ?? 'unknown'}:${safeError(errorText)}`,
          ),
        );
      }
    });
  });
}

function safeError(value: string): string {
  return value
    .replace(/[^\p{L}\p{N} ._:-]+/gu, ' ')
    .trim()
    .slice(0, 300);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('job_cancelled');
}

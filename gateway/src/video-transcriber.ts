import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SEGMENT_SECONDS = 28;

export type AudioChunkTranscriber = (audio: Uint8Array) => Promise<string>;
export type TranscriptionProgress = {
  completed: number;
  total: number;
};

export async function transcribeVideoFromUrl(
  videoUrl: string,
  transcribe: AudioChunkTranscriber,
  onProgress?: (progress: TranscriptionProgress) => Promise<void> | void,
): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'remind-video-'));
  try {
    await extractAudioSegments(
      videoUrl,
      join(tempDirectory, 'chunk-%03d.mp3'),
    );
    const names = (await readdir(tempDirectory))
      .filter((name) => /^chunk-\d+\.mp3$/.test(name))
      .sort();
    if (names.length === 0) throw new Error('视频中没有提取到可转写音频');

    const lines: string[] = [];
    await onProgress?.({ completed: 0, total: names.length });
    for (let index = 0; index < names.length; index += 1) {
      const audio = await readFile(join(tempDirectory, names[index]));
      const text = (await transcribe(audio)).replace(/\s+/g, ' ').trim();
      if (text) lines.push(`[${formatTimestamp(index * SEGMENT_SECONDS)}] ${text}`);
      await onProgress?.({
        completed: index + 1,
        total: names.length,
      });
    }
    if (lines.length === 0) throw new Error('视频音频没有识别出文字');
    return lines.join('\n');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export function formatTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function extractAudioSegments(
  videoUrl: string,
  outputPattern: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-headers',
        'Referer: https://www.xiaohongshu.com/\r\nUser-Agent: Mozilla/5.0\r\n',
        '-i',
        videoUrl,
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
        String(SEGMENT_SECONDS),
        '-reset_timestamps',
        '1',
        outputPattern,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errorText = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => {
      errorText = (errorText + chunk).slice(-2_000);
    });
    process.once('error', reject);
    process.once('close', (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`音频提取失败 (${code ?? 'unknown'}): ${errorText}`));
    });
  });
}

import {
  transcribeAudioChunk,
  type ConnectorCredentials,
} from './remind-client.js';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type TranscriptionProvider = {
  id: 'local-whisper' | 'zhipu-cloud';
  label: string;
  estimateCostMicros: (durationSeconds: number) => number;
  transcribe: (audio: Uint8Array) => Promise<string>;
};

export function cloudCostLimitMicros(
  configuredValue = process.env.REMIND_CLOUD_ASR_LIMIT_YUAN,
): number {
  const configured = Number(configuredValue);
  const yuan =
    Number.isFinite(configured) && configured >= 0 ? configured : 0.3;
  return Math.round(yuan * 1_000_000);
}

export function requiresCloudCostApproval(input: {
  estimatedCostMicros: number | null;
  costLimitMicros: number;
  approved: boolean;
}): boolean {
  return (
    !input.approved &&
    (input.estimatedCostMicros === null ||
      input.estimatedCostMicros > input.costLimitMicros)
  );
}

const DEFAULT_MLX_WHISPER =
  process.env.REMIND_MLX_WHISPER_PATH ??
  join(homedir(), '.remind-weixin', 'whisper-venv', 'bin', 'mlx_whisper');
const DEFAULT_MLX_MODEL =
  process.env.REMIND_WHISPER_MODEL_PATH ??
  join(
    homedir(),
    '.remind-weixin',
    'models',
    'whisper-small-mlx-4bit',
  );

export function createTranscriptionProvider(input: {
  apiBaseUrl: string;
  credentials: ConnectorCredentials;
}): TranscriptionProvider {
  return {
    id: 'zhipu-cloud',
    label: '智谱云端语音转写',
    estimateCostMicros: (durationSeconds) =>
      Math.round((Math.max(0, durationSeconds) / 60) * 60_000),
    transcribe: (audio) =>
      transcribeAudioChunk(input.apiBaseUrl, input.credentials, audio),
  };
}

export async function findLocalTranscriptionProvider(): Promise<
  TranscriptionProvider | undefined
> {
  try {
    await Promise.all([
      access(DEFAULT_MLX_WHISPER),
      access(join(DEFAULT_MLX_MODEL, 'config.json')),
    ]);
  } catch {
    return undefined;
  }
  return {
    id: 'local-whisper',
    label: '本地 Whisper',
    estimateCostMicros: () => 0,
    transcribe: transcribeWithLocalWhisper,
  };
}

async function transcribeWithLocalWhisper(
  audio: Uint8Array,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remind-whisper-'));
  const audioPath = join(directory, 'chunk.mp3');
  const outputName = 'transcript';
  try {
    await writeFile(audioPath, audio);
    await runProcess(
      DEFAULT_MLX_WHISPER,
      [
        audioPath,
        '--model',
        DEFAULT_MLX_MODEL,
        '--output-dir',
        directory,
        '--output-name',
        outputName,
        '--output-format',
        'txt',
        '--verbose',
        'False',
        '--task',
        'transcribe',
      ],
      90_000,
    );
    try {
      return (await readFile(join(directory, `${outputName}.txt`), 'utf8'))
        .replace(/\s+/g, ' ')
        .trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    const timer = setTimeout(() => {
      process.kill('SIGTERM');
      reject(new Error('本地 Whisper 转写超时'));
    }, timeoutMs);
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => {
      errorText = (errorText + chunk).slice(-2_000);
    });
    process.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(
              `本地 Whisper 失败 (${code ?? 'unknown'}): ${errorText}`,
            ),
          );
    });
  });
}

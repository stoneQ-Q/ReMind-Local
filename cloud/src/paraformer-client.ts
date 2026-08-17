const MAX_PROVIDER_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 12 * 60 * 1_000;

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export type ParaformerSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
  speakerId: number | null;
};

export type ParaformerTranscript = {
  transcript: string;
  segments: ParaformerSegment[];
  billableDurationSeconds: number | null;
};

export class ParaformerError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
  }
}

export class ParaformerClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    apiHost: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly maxWaitMs = DEFAULT_MAX_WAIT_MS,
  ) {
    if (!/^sk-[A-Za-z0-9._-]{20,}$/.test(apiKey)) {
      throw new Error('invalid_dashscope_api_key');
    }
    const normalizedHost = apiHost.trim().toLowerCase();
    if (
      !/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(normalizedHost)
    ) {
      throw new Error('invalid_dashscope_api_host');
    }
    this.baseUrl = `https://${normalizedHost}`;
  }

  async submit(audioUrl: string, signal: AbortSignal): Promise<string> {
    const trustedAudioUrl = validateMediaUrl(audioUrl);
    const response = await this.fetcher(
      `${this.baseUrl}/api/v1/services/audio/asr/transcription`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model: 'paraformer-v2',
          input: { file_urls: [trustedAudioUrl] },
          parameters: {
            channel_id: [0],
            language_hints: ['zh', 'en'],
            disfluency_removal_enabled: false,
            timestamp_alignment_enabled: true,
            diarization_enabled: false,
          },
        }),
        signal,
      },
    );
    if (!response.ok) throw providerHttpError(response.status);
    const payload = await readLimitedJson(response);
    const taskId = nestedString(payload, ['output', 'task_id']).trim();
    if (!/^[A-Za-z0-9-]{8,128}$/.test(taskId)) {
      throw new ParaformerError('paraformer_task_id_invalid', true);
    }
    return taskId;
  }

  async waitForTranscript(
    taskId: string,
    signal: AbortSignal,
  ): Promise<ParaformerTranscript> {
    if (!/^[A-Za-z0-9-]{8,128}$/.test(taskId)) {
      throw new ParaformerError('paraformer_task_id_invalid', true);
    }
    const deadline = Date.now() + this.maxWaitMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const response = await this.fetcher(
        `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`,
        {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal,
        },
      );
      if (!response.ok) throw providerHttpError(response.status);
      const payload = await readLimitedJson(response);
      const status = nestedString(payload, ['output', 'task_status']);
      if (status === 'PENDING' || status === 'RUNNING') {
        await abortableDelay(this.pollIntervalMs, signal);
        continue;
      }
      if (status !== 'SUCCEEDED') {
        throw new ParaformerError(
          normalizeProviderCode(
            nestedString(payload, ['output', 'code']) || status,
          ),
          true,
        );
      }
      const results = nestedArray(payload, ['output', 'results']);
      const successful = results.find(
        (value) =>
          isRecord(value) && value.subtask_status === 'SUCCEEDED',
      );
      if (!isRecord(successful)) {
        const first = results.find(isRecord);
        throw new ParaformerError(
          normalizeProviderCode(
            first ? stringValue(first, 'code') : 'paraformer_subtask_failed',
          ),
          true,
        );
      }
      const resultUrl = validateResultUrl(
        stringValue(successful, 'transcription_url'),
      );
      const resultResponse = await this.fetcher(resultUrl, {
        method: 'GET',
        redirect: 'error',
        signal,
      });
      if (!resultResponse.ok) throw providerHttpError(resultResponse.status);
      return parseTranscript(await readLimitedJson(resultResponse));
    }
    throw new ParaformerError('paraformer_poll_timeout', false);
  }
}

function parseTranscript(payload: unknown): ParaformerTranscript {
  const transcripts = isRecord(payload) && Array.isArray(payload.transcripts)
    ? payload.transcripts
    : [];
  const textParts: string[] = [];
  const segments: ParaformerSegment[] = [];
  let billableDurationMilliseconds = 0;
  let hasBillableDuration = false;
  for (const transcript of transcripts) {
    if (!isRecord(transcript)) continue;
    const text = cleanText(stringValue(transcript, 'text'), 1_000_000);
    if (text) textParts.push(text);
    const contentDuration = numberValue(
      transcript,
      'content_duration_in_milliseconds',
    );
    if (contentDuration !== null && contentDuration >= 0) {
      hasBillableDuration = true;
      billableDurationMilliseconds += contentDuration;
    }
    const sentences = Array.isArray(transcript.sentences)
      ? transcript.sentences
      : [];
    for (const sentence of sentences) {
      if (!isRecord(sentence)) continue;
      const sentenceText = cleanText(stringValue(sentence, 'text'), 20_000);
      const begin = numberValue(sentence, 'begin_time');
      const end = numberValue(sentence, 'end_time');
      if (!sentenceText || begin === null || end === null || end < begin) {
        continue;
      }
      const speaker = numberValue(sentence, 'speaker_id');
      segments.push({
        startSeconds: Math.max(0, Math.round(begin / 1_000)),
        endSeconds: Math.max(0, Math.round(end / 1_000)),
        text: sentenceText,
        speakerId: speaker === null ? null : Math.max(0, Math.round(speaker)),
      });
      if (segments.length >= 20_000) break;
    }
  }
  const transcript = cleanText(textParts.join('\n'), 2_000_000);
  if (!transcript) {
    throw new ParaformerError('paraformer_transcript_empty', true);
  }
  return {
    transcript,
    segments,
    billableDurationSeconds: hasBillableDuration
      ? Math.max(1, Math.ceil(billableDurationMilliseconds / 1_000))
      : null,
  };
}

function validateMediaUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParaformerError('paraformer_audio_url_invalid', true);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !(
      hostname === 'xyzcdn.net' ||
      hostname.endsWith('.xyzcdn.net') ||
      hostname === 'xhscdn.com' ||
      hostname.endsWith('.xhscdn.com')
    ) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new ParaformerError('paraformer_audio_url_invalid', true);
  }
  return url.toString();
}

function validateResultUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParaformerError('paraformer_result_url_invalid', true);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !hostname.endsWith('.oss-cn-beijing.aliyuncs.com') ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new ParaformerError('paraformer_result_url_invalid', true);
  }
  return url.toString();
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declared) &&
    declared > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new ParaformerError('paraformer_response_too_large', true);
  }
  if (!response.body) {
    throw new ParaformerError('paraformer_response_empty', true);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ParaformerError('paraformer_response_too_large', true);
    }
    chunks.push(part.value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ParaformerError('paraformer_response_invalid', true);
  }
}

function providerHttpError(status: number): ParaformerError {
  return new ParaformerError(
    `paraformer_http_${status}`,
    status >= 400 && status < 500 && status !== 408 && status !== 429,
  );
}

function nestedString(value: unknown, path: string[]): string {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return '';
    current = current[key];
  }
  return typeof current === 'string' ? current : '';
}

function nestedArray(value: unknown, path: string[]): unknown[] {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function numberValue(value: Record<string, unknown>, key: string): number | null {
  const number = value[key];
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function normalizeProviderCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'paraformer_task_failed';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const ZHIPU_CHAT_URL =
  'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_ASR_URL =
  'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const ZHIPU_VISION_MODEL = 'glm-4.6v';
export const ZHIPU_ASR_MODEL = 'glm-asr-2512';
export const DEEPSEEK_MEDIA_MODEL = 'deepseek-v4-flash';

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderUsage = {
  promptTokens: number;
  completionTokens: number;
};

export class MediaProviderHttpError extends Error {
  constructor(
    readonly provider: 'zhipu' | 'deepseek',
    readonly status: number,
  ) {
    super(`${provider}_http_${status}`);
  }
}

export class ZhipuMediaClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async analyzeImage(
    apiKey: string,
    input: {
      content: Uint8Array;
      contentType: 'image/jpeg' | 'image/png' | 'image/webp';
    },
    signal: AbortSignal,
  ): Promise<{ description: string; tags: string[]; model: string }> {
    requireApiKey(apiKey);
    if (input.content.byteLength < 1 || input.content.byteLength > 20_000_000) {
      throw new Error('invalid_image_size');
    }
    const dataUrl =
      `data:${input.contentType};base64,${Buffer.from(input.content).toString('base64')}`;
    const response = await this.fetcher(ZHIPU_CHAT_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ZHIPU_VISION_MODEL,
        thinking: { type: 'disabled' },
        temperature: 0.1,
        max_tokens: 1_800,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: imagePrompt() },
            ],
          },
        ],
      }),
      signal,
    });
    if (!response.ok) throw new MediaProviderHttpError('zhipu', response.status);
    const payload = await readLimitedJson(response);
    const description = chatContent(payload);
    if (description.length < 10) throw new Error('zhipu_empty_image_analysis');
    return {
      description: description.slice(0, 10_000),
      tags: [],
      model: ZHIPU_VISION_MODEL,
    };
  }

  async transcribeAudio(
    apiKey: string,
    input: {
      content: Uint8Array;
      contentType: string;
      fileName?: string;
    },
    signal: AbortSignal,
  ): Promise<{ transcript: string; model: string }> {
    requireApiKey(apiKey);
    if (input.content.byteLength < 1 || input.content.byteLength > 100_000_000) {
      throw new Error('invalid_audio_size');
    }
    const form = new FormData();
    form.append('model', ZHIPU_ASR_MODEL);
    form.append('stream', 'false');
    form.append(
      'file',
      new Blob([Uint8Array.from(input.content).buffer], {
        type: input.contentType,
      }),
      safeAudioName(input.fileName),
    );
    const response = await this.fetcher(ZHIPU_ASR_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
    if (!response.ok) throw new MediaProviderHttpError('zhipu', response.status);
    const payload = await readLimitedJson(response);
    const transcript = recordString(payload, 'text').trim();
    if (!transcript) throw new Error('zhipu_empty_transcription');
    return {
      transcript: transcript.replace(/\u0000/g, '').slice(0, 100_000),
      model: ZHIPU_ASR_MODEL,
    };
  }
}

export class DeepSeekMediaClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async summarizeVideoTranscript(
    apiKey: string,
    transcript: string,
    signal: AbortSignal,
  ): Promise<{
    summary: string;
    highlights: string[];
    model: string;
    usage: ProviderUsage;
  }> {
    requireApiKey(apiKey);
    const safeTranscript = transcript.replace(/\u0000/g, '').trim().slice(0, 100_000);
    if (!safeTranscript) throw new Error('empty_video_transcript');
    const response = await this.fetcher(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEEPSEEK_MEDIA_MODEL,
        thinking: { type: 'disabled' },
        temperature: 0.1,
        max_tokens: 1_500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是 ReMind 视频整理助手。只根据转写内容输出 JSON，不补充未出现的事实。',
          },
          {
            role: 'user',
            content:
              `${safeTranscript}\n\n请输出 JSON：` +
              '{"summary":"简洁总结","highlights":["最多十条重点"]}',
          },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      throw new MediaProviderHttpError('deepseek', response.status);
    }
    const payload = await readLimitedJson(response);
    const content = chatContent(payload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new Error('deepseek_invalid_media_json');
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.highlights)) {
      throw new Error('deepseek_invalid_media_json');
    }
    const summary = recordString(parsed, 'summary').trim().slice(0, 20_000);
    const highlights = parsed.highlights
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.replace(/\u0000/g, '').trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 10);
    if (!summary) throw new Error('deepseek_empty_media_summary');
    return {
      summary,
      highlights,
      model: DEEPSEEK_MEDIA_MODEL,
      usage: readUsage(payload),
    };
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('provider_response_too_large');
  }
  if (!response.body) throw new Error('provider_empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('provider_response_too_large');
    }
    chunks.push(part.value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('provider_invalid_json');
  }
}

function chatContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error('provider_invalid_response');
  }
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error('provider_invalid_response');
  }
  return recordString(first.message, 'content').trim();
}

function readUsage(payload: unknown): ProviderUsage {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    throw new Error('provider_usage_missing');
  }
  return {
    promptTokens: recordNonnegativeInteger(payload.usage, 'prompt_tokens'),
    completionTokens: recordNonnegativeInteger(
      payload.usage,
      'completion_tokens',
    ),
  };
}

function recordString(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== 'string') {
    throw new Error('provider_invalid_response');
  }
  return value[key];
}

function recordNonnegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const result = value[key];
  if (!Number.isSafeInteger(result) || (result as number) < 0) {
    throw new Error('provider_invalid_usage');
  }
  return result as number;
}

function requireApiKey(value: string): void {
  if (
    value.length < 12 ||
    value.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error('invalid_provider_credential');
  }
}

function safeAudioName(value: string | undefined): string {
  const normalized = value
    ?.replace(/[\u0000-\u001F\u007F/\\]+/g, '_')
    .trim()
    .slice(0, 120);
  return normalized || 'audio.mp3';
}

function imagePrompt(): string {
  return [
    '请只描述图片中清晰可见、对记录有帮助的事实。',
    '不要猜测身份、地点或图片外信息。',
    '输出简洁中文 Markdown，总长度不超过 800 字。',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

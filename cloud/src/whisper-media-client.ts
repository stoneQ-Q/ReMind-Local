const MAX_AUDIO_BYTES = 100_000_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export class WhisperMediaClient {
  private readonly inferenceUrl: string;

  constructor(
    serviceUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.inferenceUrl = whisperInferenceUrl(serviceUrl);
  }

  async transcribeAudio(
    input: { content: Uint8Array; contentType: string },
    signal: AbortSignal,
  ): Promise<{ transcript: string; model: 'whisper-small-q5_1' }> {
    if (input.content.byteLength < 1 || input.content.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('invalid_audio_size');
    }
    const form = new FormData();
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('temperature_inc', '0.2');
    form.append(
      'file',
      new Blob([Uint8Array.from(input.content).buffer], {
        type: input.contentType,
      }),
      whisperAudioName(input.contentType),
    );
    const response = await this.fetcher(this.inferenceUrl, {
      method: 'POST',
      redirect: 'error',
      body: form,
      signal,
    });
    if (!response.ok) throw new Error(`whisper_http_${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      throw new Error('whisper_response_too_large');
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new Error('whisper_response_too_large');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('whisper_invalid_response');
    }
    const transcript =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).text
        : null;
    if (typeof transcript !== 'string' || !transcript.trim()) {
      throw new Error('whisper_empty_transcription');
    }
    return {
      transcript: transcript.replace(/\u0000/g, '').trim().slice(0, 100_000),
      model: 'whisper-small-q5_1',
    };
  }
}

function whisperAudioName(contentType: string): string {
  if (contentType.includes('wav')) return 'audio.wav';
  if (contentType.includes('ogg')) return 'audio.ogg';
  if (contentType.includes('flac')) return 'audio.flac';
  if (contentType.includes('mp4') || contentType.includes('m4a')) {
    return 'audio.m4a';
  }
  return 'audio.mp3';
}

function whisperInferenceUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid_whisper_service_url');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/inference`;
  return url.toString();
}

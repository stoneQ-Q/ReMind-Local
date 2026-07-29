import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import {
  DeepSeekMediaClient,
  MediaProviderHttpError,
  ZhipuMediaClient,
} from './media-provider-clients.js';
import {
  resolveMediaProviderCredential,
} from './media-provider-routing.js';
import {
  FfmpegMediaProcessingProvider,
  type MediaProviderContext,
} from './media-processing.js';
import {
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-health.js';

export class ByokMediaProcessingProvider extends FfmpegMediaProcessingProvider {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: CredentialCipher,
    private readonly zhipu = new ZhipuMediaClient(),
    private readonly deepseek = new DeepSeekMediaClient(),
  ) {
    super();
  }

  override async transcribeAudio(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType = 'audio/mpeg',
  ): Promise<string> {
    const required = requireContext(context);
    const credential = await resolveMediaProviderCredential(
      this.pool,
      this.cipher,
      {
        ...required,
        provider: 'zhipu',
      },
    );
    return this.withHealth('zhipu', async () => {
      const result = await this.zhipu.transcribeAudio(
        credential.apiKey,
        { content, contentType },
        signal,
      );
      return result.transcript;
    });
  }

  override async analyzeImage(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType = 'image/jpeg',
  ): Promise<{ description: string; tags: string[] }> {
    const required = requireContext(context);
    if (!isImageContentType(contentType)) throw new Error('invalid_image_type');
    const credential = await resolveMediaProviderCredential(
      this.pool,
      this.cipher,
      {
        ...required,
        provider: 'zhipu',
      },
    );
    return this.withHealth('zhipu', async () =>
      this.zhipu.analyzeImage(
        credential.apiKey,
        { content, contentType },
        signal,
      ),
    );
  }

  override async analyzeVideoTranscript(
    transcript: string,
    signal: AbortSignal,
    context?: MediaProviderContext,
  ): Promise<{ summary: string; highlights: string[] }> {
    const required = requireContext(context);
    const credential = await resolveMediaProviderCredential(
      this.pool,
      this.cipher,
      {
        ...required,
        provider: 'deepseek',
      },
    );
    return this.withHealth('deepseek', async () =>
      this.deepseek.summarizeVideoTranscript(
        credential.apiKey,
        transcript,
        signal,
      ),
    );
  }

  private async withHealth<T>(
    provider: 'zhipu' | 'deepseek',
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      await recordProviderSuccess(this.pool, provider);
      return result;
    } catch (error) {
      if (shouldCountProviderFailure(error)) {
        await recordProviderFailure(
          this.pool,
          provider,
          error instanceof Error ? error.message : 'provider_failed',
        );
      }
      throw error;
    }
  }
}

function shouldCountProviderFailure(error: unknown): boolean {
  if (error instanceof MediaProviderHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'job_cancelled')
  ) {
    return false;
  }
  return true;
}

function requireContext(
  value: MediaProviderContext | undefined,
): MediaProviderContext {
  if (!value) throw new Error('media_provider_context_required');
  return value;
}

function isImageContentType(
  value: string,
): value is 'image/jpeg' | 'image/png' | 'image/webp' {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

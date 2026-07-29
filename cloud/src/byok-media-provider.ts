import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import {
  DeepSeekMediaClient,
  MediaProviderHttpError,
  ZhipuMediaClient,
} from './media-provider-clients.js';
import {
  resolveMediaProviderCredential,
  type ManagedProviderCredentials,
} from './media-provider-routing.js';
import {
  FfmpegMediaProcessingProvider,
  type MediaProviderContext,
  type MediaProviderStageResult,
} from './media-processing.js';
import {
  actualManagedTextCost,
  estimateManagedImageCost,
  estimateManagedTranscriptionCost,
  type ManagedMediaPriceCatalog,
} from './media-pricing.js';
import {
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-health.js';

type RemoteMediaProviderOptions = {
  managedCredentials?: ManagedProviderCredentials;
  managedPriceCatalog?: ManagedMediaPriceCatalog;
};

export class RemoteMediaProcessingProvider extends FfmpegMediaProcessingProvider {
  readonly requiresTrustedDuration: boolean;

  constructor(
    private readonly pool: Pool,
    private readonly cipher: CredentialCipher,
    private readonly options: RemoteMediaProviderOptions = {},
    private readonly zhipu = new ZhipuMediaClient(),
    private readonly deepseek = new DeepSeekMediaClient(),
  ) {
    super();
    this.requiresTrustedDuration = Boolean(options.managedPriceCatalog);
  }

  override async transcribeAudio(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType = 'audio/mpeg',
  ): Promise<MediaProviderStageResult<string>> {
    const required = requireContext(context);
    const credential = await resolveMediaProviderCredential(
      this.pool,
      this.cipher,
      {
        ...required,
        provider: 'zhipu',
        managedCredentials: this.options.managedCredentials,
      },
    );
    return this.withHealth('zhipu', credential.mode, async () => {
      const result = await this.zhipu.transcribeAudio(
        credential.apiKey,
        { content, contentType },
        signal,
      );
      return {
        output: result.transcript,
        actualCostMicros: credential.billPlatformCost
          ? estimateManagedTranscriptionCost(
              requireCatalog(this.options),
              requireDurationSeconds(required.durationSeconds),
            )
          : 0n,
      };
    });
  }

  override async analyzeImage(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType = 'image/jpeg',
  ): Promise<
    MediaProviderStageResult<{ description: string; tags: string[] }>
  > {
    const required = requireContext(context);
    if (!isImageContentType(contentType)) throw new Error('invalid_image_type');
    const credential = await resolveMediaProviderCredential(
      this.pool,
      this.cipher,
      {
        ...required,
        provider: 'zhipu',
        managedCredentials: this.options.managedCredentials,
      },
    );
    return this.withHealth('zhipu', credential.mode, async () => ({
      output: await this.zhipu.analyzeImage(
        credential.apiKey,
        { content, contentType },
        signal,
      ),
      actualCostMicros: credential.billPlatformCost
        ? estimateManagedImageCost(requireCatalog(this.options))
        : 0n,
    }));
  }

  override async analyzeVideoTranscript(
    transcript: string,
    signal: AbortSignal,
    context?: MediaProviderContext,
  ): Promise<
    MediaProviderStageResult<{ summary: string; highlights: string[] }>
  > {
    const required = requireContext(context);
    const credential = await resolveMediaProviderCredential(
      this.pool,
      this.cipher,
      {
        ...required,
        provider: 'deepseek',
        managedCredentials: this.options.managedCredentials,
      },
    );
    return this.withHealth('deepseek', credential.mode, async () => {
      const result = await this.deepseek.summarizeVideoTranscript(
        credential.apiKey,
        transcript,
        signal,
      );
      return {
        output: result,
        actualCostMicros: credential.billPlatformCost
          ? actualManagedTextCost(
              requireCatalog(this.options),
              result.usage.promptTokens,
              result.usage.completionTokens,
            )
          : 0n,
      };
    });
  }

  private async withHealth<T>(
    provider: 'zhipu' | 'deepseek',
    mode: 'bring_your_own_key' | 'managed',
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      await recordProviderSuccess(this.pool, provider);
      return result;
    } catch (error) {
      if (shouldCountProviderFailure(error, mode)) {
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

export class ByokMediaProcessingProvider extends RemoteMediaProcessingProvider {
  constructor(
    pool: Pool,
    cipher: CredentialCipher,
    zhipu = new ZhipuMediaClient(),
    deepseek = new DeepSeekMediaClient(),
  ) {
    super(pool, cipher, {}, zhipu, deepseek);
  }
}

function shouldCountProviderFailure(
  error: unknown,
  mode: 'bring_your_own_key' | 'managed',
): boolean {
  if (error instanceof MediaProviderHttpError) {
    return (
      error.status === 429 ||
      error.status >= 500 ||
      (mode === 'managed' && (error.status === 401 || error.status === 403))
    );
  }
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'job_cancelled')
  ) {
    return false;
  }
  return true;
}

function requireCatalog(
  options: RemoteMediaProviderOptions,
): ManagedMediaPriceCatalog {
  if (!options.managedPriceCatalog) {
    throw new Error('managed_media_pricing_unavailable');
  }
  return options.managedPriceCatalog;
}

function requireDurationSeconds(value: number | null): number {
  if (!Number.isInteger(value) || value === null || value < 1 || value > 21_600) {
    throw new Error('invalid_media_duration');
  }
  return value;
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

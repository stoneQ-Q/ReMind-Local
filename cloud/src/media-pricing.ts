const ONE_MILLION = 1_000_000n;
const SECONDS_PER_MINUTE = 60n;

export type ManagedTextPriceCatalog = {
  deepseekInputPerMillionTokensMicros: bigint;
  deepseekOutputPerMillionTokensMicros: bigint;
};

export type ManagedMediaPriceCatalog = ManagedTextPriceCatalog & {
  zhipuVisionPerImageMicros: bigint;
  zhipuAsrPerMinuteMicros: bigint;
};

export class ManagedMediaPricingUnavailableError extends Error {
  constructor() {
    super('managed_media_pricing_unavailable');
  }
}

export function managedMediaPriceCatalogFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ManagedMediaPriceCatalog {
  return {
    zhipuVisionPerImageMicros: requiredPositiveMicros(
      environment.REMIND_PRICE_ZHIPU_VISION_PER_IMAGE_MICROS,
    ),
    zhipuAsrPerMinuteMicros: requiredPositiveMicros(
      environment.REMIND_PRICE_ZHIPU_ASR_PER_MINUTE_MICROS,
    ),
    deepseekInputPerMillionTokensMicros: requiredPositiveMicros(
      environment.REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS,
    ),
    deepseekOutputPerMillionTokensMicros: requiredPositiveMicros(
      environment.REMIND_PRICE_DEEPSEEK_OUTPUT_PER_MILLION_TOKENS_MICROS,
    ),
  };
}

export function managedTextPriceCatalogFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ManagedTextPriceCatalog {
  return {
    deepseekInputPerMillionTokensMicros: requiredPositiveMicros(
      environment.REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS,
    ),
    deepseekOutputPerMillionTokensMicros: requiredPositiveMicros(
      environment.REMIND_PRICE_DEEPSEEK_OUTPUT_PER_MILLION_TOKENS_MICROS,
    ),
  };
}

export function estimateManagedImageCost(
  catalog: ManagedMediaPriceCatalog,
  imageCount = 1,
): bigint {
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 8) {
    throw new Error('invalid_image_count');
  }
  return catalog.zhipuVisionPerImageMicros * BigInt(imageCount);
}

export function estimateManagedTranscriptionCost(
  catalog: ManagedMediaPriceCatalog,
  durationSeconds: number,
): bigint {
  const seconds = validDurationSeconds(durationSeconds);
  return ceilDivide(
    catalog.zhipuAsrPerMinuteMicros * BigInt(seconds),
    SECONDS_PER_MINUTE,
  );
}

export function estimateManagedTextCost(
  catalog: ManagedTextPriceCatalog,
  inputTokens: number,
  maximumOutputTokens: number,
): bigint {
  return (
    tokenCost(
      catalog.deepseekInputPerMillionTokensMicros,
      validTokenCount(inputTokens),
    ) +
    tokenCost(
      catalog.deepseekOutputPerMillionTokensMicros,
      validTokenCount(maximumOutputTokens),
    )
  );
}

export function actualManagedTextCost(
  catalog: ManagedTextPriceCatalog,
  promptTokens: number,
  completionTokens: number,
): bigint {
  return (
    tokenCost(
      catalog.deepseekInputPerMillionTokensMicros,
      validTokenCount(promptTokens),
    ) +
    tokenCost(
      catalog.deepseekOutputPerMillionTokensMicros,
      validTokenCount(completionTokens),
    )
  );
}

function tokenCost(rate: bigint, tokens: number): bigint {
  return ceilDivide(rate * BigInt(tokens), ONE_MILLION);
}

function requiredPositiveMicros(value: string | undefined): bigint {
  const normalized = value?.trim() ?? '';
  if (!/^[1-9][0-9]{0,17}$/.test(normalized)) {
    throw new ManagedMediaPricingUnavailableError();
  }
  return BigInt(normalized);
}

function validDurationSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 21_600) {
    throw new Error('invalid_media_duration');
  }
  return value;
}

function validTokenCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw new Error('invalid_token_count');
  }
  return value;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

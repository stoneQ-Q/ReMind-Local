import { describe, expect, it } from 'vitest';

import {
  actualManagedTextCost,
  estimateManagedImageCost,
  estimateManagedTextCost,
  estimateManagedTranscriptionCost,
  managedMediaPriceCatalogFromEnvironment,
  managedTextPriceCatalogFromEnvironment,
  ManagedMediaPricingUnavailableError,
} from './media-pricing.js';

const catalog = {
  zhipuVisionPerImageMicros: 250_000n,
  zhipuAsrPerMinuteMicros: 60_000n,
  deepseekInputPerMillionTokensMicros: 2_000_000n,
  deepseekOutputPerMillionTokensMicros: 8_000_000n,
};

describe('managed media pricing', () => {
  it('loads text-only pricing without enabling managed media', () => {
    expect(
      managedTextPriceCatalogFromEnvironment({
        REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS: '1000000',
        REMIND_PRICE_DEEPSEEK_OUTPUT_PER_MILLION_TOKENS_MICROS: '2000000',
      }),
    ).toEqual({
      deepseekInputPerMillionTokensMicros: 1_000_000n,
      deepseekOutputPerMillionTokensMicros: 2_000_000n,
    });
  });

  it('refuses managed pricing when any server-side rate is absent', () => {
    expect(() => managedMediaPriceCatalogFromEnvironment({})).toThrow(
      ManagedMediaPricingUnavailableError,
    );
    expect(() =>
      managedMediaPriceCatalogFromEnvironment({
        REMIND_PRICE_ZHIPU_VISION_PER_IMAGE_MICROS: '250000',
        REMIND_PRICE_ZHIPU_ASR_PER_MINUTE_MICROS: '60000',
        REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS: '2000000',
      }),
    ).toThrow('managed_media_pricing_unavailable');
  });

  it('loads only positive integer micro-CNY rates', () => {
    expect(
      managedMediaPriceCatalogFromEnvironment({
        REMIND_PRICE_ZHIPU_VISION_PER_IMAGE_MICROS: '250000',
        REMIND_PRICE_ZHIPU_ASR_PER_MINUTE_MICROS: '60000',
        REMIND_PRICE_DEEPSEEK_INPUT_PER_MILLION_TOKENS_MICROS: '2000000',
        REMIND_PRICE_DEEPSEEK_OUTPUT_PER_MILLION_TOKENS_MICROS: '8000000',
      }),
    ).toEqual(catalog);
  });

  it('rounds duration and token estimates upward without floating point', () => {
    expect(estimateManagedImageCost(catalog, 3)).toBe(750_000n);
    expect(estimateManagedTranscriptionCost(catalog, 1)).toBe(1_000n);
    expect(estimateManagedTranscriptionCost(catalog, 61)).toBe(61_000n);
    expect(estimateManagedTextCost(catalog, 1_500, 500)).toBe(7_000n);
    expect(actualManagedTextCost(catalog, 1_200, 300)).toBe(4_800n);
  });

  it('rejects unbounded client-controlled quantities', () => {
    expect(() => estimateManagedImageCost(catalog, 0)).toThrow(
      'invalid_image_count',
    );
    expect(() => estimateManagedTranscriptionCost(catalog, 21_601)).toThrow(
      'invalid_media_duration',
    );
    expect(() => estimateManagedTextCost(catalog, -1, 100)).toThrow(
      'invalid_token_count',
    );
  });
});

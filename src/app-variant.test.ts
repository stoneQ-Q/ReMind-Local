import { afterEach, describe, expect, it } from 'vitest';

import {
  getReMindAppVariant,
  isConsumerReMindApp,
  isPublicLocalReMindApp,
} from './app-variant';

afterEach(() => {
  delete process.env.EXPO_PUBLIC_REMIND_APP_VARIANT;
});

describe('app variant', () => {
  it('defaults to the zero-configuration consumer app', () => {
    expect(getReMindAppVariant()).toBe('consumer');
    expect(isConsumerReMindApp()).toBe(true);
    expect(isPublicLocalReMindApp()).toBe(false);
  });

  it('keeps the public local build explicitly self-hosted', () => {
    process.env.EXPO_PUBLIC_REMIND_APP_VARIANT = 'public-local';

    expect(getReMindAppVariant()).toBe('public-local');
    expect(isConsumerReMindApp()).toBe(false);
    expect(isPublicLocalReMindApp()).toBe(true);
  });
});

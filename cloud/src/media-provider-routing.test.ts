import { describe, expect, it } from 'vitest';

import {
  MediaProviderAuthorizationError,
  requiredManagedProviderCredentialsFromEnvironment,
} from './media-provider-routing.js';

describe('managed provider environment', () => {
  it('requires both platform credentials before remote mode starts', () => {
    expect(() => requiredManagedProviderCredentialsFromEnvironment({})).toThrow(
      MediaProviderAuthorizationError,
    );
    expect(() =>
      requiredManagedProviderCredentialsFromEnvironment({
        REMIND_MANAGED_ZHIPU_API_KEY: 'only-one-key',
      }),
    ).toThrow('managed_provider_credential_required');
  });

  it('returns only the two supported platform credentials', () => {
    expect(
      requiredManagedProviderCredentialsFromEnvironment({
        REMIND_MANAGED_ZHIPU_API_KEY: 'platform-zhipu-key',
        REMIND_MANAGED_DEEPSEEK_API_KEY: 'platform-deepseek-key',
        UNRELATED_SECRET: 'ignored',
      }),
    ).toEqual({
      zhipu: 'platform-zhipu-key',
      deepseek: 'platform-deepseek-key',
    });
  });
});

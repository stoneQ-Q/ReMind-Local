import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReMindApiUrl,
  credentialScope,
  getReMindServiceConfig,
} from './service-contract';

const ENV_KEYS = [
  'EXPO_PUBLIC_REMIND_API_URL',
  'EXPO_PUBLIC_REMIND_API_VERSION',
  'EXPO_PUBLIC_REMIND_SERVICE_MODE',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('ReMind service contract', () => {
  it('keeps the existing local API and credential scope by default', () => {
    process.env.EXPO_PUBLIC_REMIND_API_URL = 'http://192.168.1.8:8787/';

    const config = getReMindServiceConfig();

    expect(config).toEqual({
      mode: 'self-hosted',
      baseUrl: 'http://192.168.1.8:8787',
      apiVersion: 'v1',
      routeStyle: 'legacy',
    });
    expect(buildReMindApiUrl(config!, 'devices')).toBe(
      'http://192.168.1.8:8787/api/devices',
    );
    expect(credentialScope(config!)).toBe('http://192.168.1.8:8787');
  });

  it('uses the versioned API only when hosted V1 is explicit', () => {
    process.env.EXPO_PUBLIC_REMIND_API_URL = 'https://api.remind.example';
    process.env.EXPO_PUBLIC_REMIND_API_VERSION = 'v1';
    process.env.EXPO_PUBLIC_REMIND_SERVICE_MODE = 'hosted';

    const config = getReMindServiceConfig();

    expect(config?.mode).toBe('hosted');
    expect(config?.routeStyle).toBe('versioned');
    expect(buildReMindApiUrl(config!, '/devices/device-1/status')).toBe(
      'https://api.remind.example/api/v1/devices/device-1/status',
    );
    expect(credentialScope(config!)).toBe(
      'hosted:https://api.remind.example:v1',
    );
  });

  it('is unconfigured when no service address is present', () => {
    expect(getReMindServiceConfig()).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureValues = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureValues.set(key, value);
  }),
}));

import {
  getActiveReMindAppMode,
  setActiveReMindAppMode,
  setRuntimeLocalServiceBaseUrl,
} from './service-contract';
import {
  configureLocalReMindService,
  initializeReMindServiceMode,
  normalizeUserLocalBaseUrl,
  selectReMindServiceMode,
} from './service-mode';

const ENV_KEYS = [
  'EXPO_PUBLIC_REMIND_API_URL',
  'EXPO_PUBLIC_REMIND_API_VERSION',
  'EXPO_PUBLIC_REMIND_SERVICE_MODE',
  'EXPO_PUBLIC_REMIND_LOCAL_API_URL',
  'EXPO_PUBLIC_REMIND_CLOUD_API_URL',
] as const;

beforeEach(() => {
  process.env.EXPO_PUBLIC_REMIND_LOCAL_API_URL = 'http://192.168.1.8:8787';
  process.env.EXPO_PUBLIC_REMIND_CLOUD_API_URL =
    'https://api.remind.example';
  secureValues.clear();
  setActiveReMindAppMode(null);
  setRuntimeLocalServiceBaseUrl(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  setActiveReMindAppMode(null);
  setRuntimeLocalServiceBaseUrl(null);
  vi.unstubAllGlobals();
});

describe('ReMind service mode persistence', () => {
  it('restores a previously selected available mode', async () => {
    secureValues.set('remind.service.mode.v1', 'cloud');

    const status = await initializeReMindServiceMode();

    expect(status.active).toBe('cloud');
    expect(getActiveReMindAppMode()).toBe('cloud');
  });

  it('probes the target before persisting and switching', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const status = await selectReMindServiceMode('cloud');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.remind.example/ready',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    );
    expect(status.active).toBe('cloud');
    expect(secureValues.get('remind.service.mode.v1')).toBe('cloud');
  });

  it('keeps the original mode when the target probe fails', async () => {
    setActiveReMindAppMode('local');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(selectReMindServiceMode('cloud')).rejects.toThrow(
      'cloud_service_unavailable',
    );
    expect(getActiveReMindAppMode()).toBe('local');
    expect(secureValues.has('remind.service.mode.v1')).toBe(false);
  });

  it('stores a checked user-provided local address and switches to it', async () => {
    delete process.env.EXPO_PUBLIC_REMIND_LOCAL_API_URL;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const status = await configureLocalReMindService(
      'macbook-pro.local:8787',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://macbook-pro.local:8787/health',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(status).toMatchObject({
      active: 'local',
      localBaseUrl: 'http://macbook-pro.local:8787',
    });
    expect(secureValues.get('remind.service.local-api-url.v1')).toBe(
      'http://macbook-pro.local:8787',
    );
  });

  it('restores a user-provided local address before resolving the mode', async () => {
    delete process.env.EXPO_PUBLIC_REMIND_LOCAL_API_URL;
    secureValues.set(
      'remind.service.local-api-url.v1',
      'http://192.168.50.10:8787',
    );
    secureValues.set('remind.service.mode.v1', 'local');

    await expect(initializeReMindServiceMode()).resolves.toMatchObject({
      active: 'local',
      localBaseUrl: 'http://192.168.50.10:8787',
    });
  });

  it('accepts only bare HTTP(S) service origins', () => {
    expect(normalizeUserLocalBaseUrl('192.168.1.9:8787')).toBe(
      'http://192.168.1.9:8787',
    );
    expect(normalizeUserLocalBaseUrl('https://remind.local/')).toBe(
      'https://remind.local',
    );
    expect(() => normalizeUserLocalBaseUrl('ftp://host/path')).toThrow(
      'local_service_address_invalid',
    );
    expect(() =>
      normalizeUserLocalBaseUrl('http://user:pass@host:8787'),
    ).toThrow('local_service_address_invalid');
  });
});

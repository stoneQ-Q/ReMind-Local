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
} from './service-contract';
import {
  initializeReMindServiceMode,
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
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  setActiveReMindAppMode(null);
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
});

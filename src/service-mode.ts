import * as SecureStore from 'expo-secure-store';

import {
  getActiveReMindAppMode,
  getAvailableReMindAppModes,
  getRuntimeLocalServiceBaseUrl,
  getReMindServiceConfigForMode,
  setActiveReMindAppMode,
  setRuntimeLocalServiceBaseUrl,
  type ReMindAppMode,
} from './service-contract';
import {
  REMIND_LOCAL_API_URL_STORAGE_KEY,
  REMIND_SERVICE_MODE_STORAGE_KEY,
} from './persistence-contract';
const PROBE_TIMEOUT_MS = 5_000;

export type ReMindModeStatus = {
  active: ReMindAppMode;
  available: Record<ReMindAppMode, boolean>;
  localBaseUrl: string | null;
};

export async function initializeReMindServiceMode(): Promise<ReMindModeStatus> {
  const [stored, storedLocalBaseUrl] = await Promise.all([
    SecureStore.getItemAsync(REMIND_SERVICE_MODE_STORAGE_KEY).catch(() => null),
    SecureStore.getItemAsync(REMIND_LOCAL_API_URL_STORAGE_KEY).catch(() => null),
  ]);
  setRuntimeLocalServiceBaseUrl(storedLocalBaseUrl);
  if (
    (stored === 'local' || stored === 'cloud') &&
    getReMindServiceConfigForMode(stored)
  ) {
    setActiveReMindAppMode(stored);
  } else {
    setActiveReMindAppMode(null);
  }
  return getReMindModeStatus();
}

export function getReMindModeStatus(): ReMindModeStatus {
  return {
    active: getActiveReMindAppMode(),
    available: getAvailableReMindAppModes(),
    localBaseUrl:
      getRuntimeLocalServiceBaseUrl() ??
      getReMindServiceConfigForMode('local')?.baseUrl ??
      null,
  };
}

export async function configureLocalReMindService(
  input: string,
): Promise<ReMindModeStatus> {
  const baseUrl = normalizeUserLocalBaseUrl(input);
  await probeService(baseUrl, 'local');
  await Promise.all([
    SecureStore.setItemAsync(REMIND_LOCAL_API_URL_STORAGE_KEY, baseUrl, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
    SecureStore.setItemAsync(REMIND_SERVICE_MODE_STORAGE_KEY, 'local', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ]);
  setRuntimeLocalServiceBaseUrl(baseUrl);
  setActiveReMindAppMode('local');
  return getReMindModeStatus();
}

export async function selectReMindServiceMode(
  mode: ReMindAppMode,
): Promise<ReMindModeStatus> {
  const config = getReMindServiceConfigForMode(mode);
  if (!config) throw new Error(`${mode}_service_not_configured`);

  await probeService(config.baseUrl, mode);
  await SecureStore.setItemAsync(REMIND_SERVICE_MODE_STORAGE_KEY, mode, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  setActiveReMindAppMode(mode);
  return getReMindModeStatus();
}

export function normalizeUserLocalBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('local_service_address_required');
  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('local_service_address_invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('local_service_address_invalid');
  }
  return url.origin;
}

async function probeService(
  baseUrl: string,
  mode: ReMindAppMode,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${baseUrl}${mode === 'cloud' ? '/ready' : '/health'}`,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
    } | null;
    if (!response.ok || payload?.ok !== true) {
      throw new Error(`${mode}_service_unavailable`);
    }
  } finally {
    clearTimeout(timer);
  }
}

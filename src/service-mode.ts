import * as SecureStore from 'expo-secure-store';

import {
  getActiveReMindAppMode,
  getAvailableReMindAppModes,
  getReMindServiceConfigForMode,
  setActiveReMindAppMode,
  type ReMindAppMode,
} from './service-contract';
import { REMIND_SERVICE_MODE_STORAGE_KEY } from './persistence-contract';
const PROBE_TIMEOUT_MS = 5_000;

export type ReMindModeStatus = {
  active: ReMindAppMode;
  available: Record<ReMindAppMode, boolean>;
};

export async function initializeReMindServiceMode(): Promise<ReMindModeStatus> {
  const stored = await SecureStore.getItemAsync(
    REMIND_SERVICE_MODE_STORAGE_KEY,
  ).catch(() => null);
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
  };
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

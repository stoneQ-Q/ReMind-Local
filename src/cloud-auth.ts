import * as SecureStore from 'expo-secure-store';

import {
  shouldRefreshCloudSession,
  type CloudSession,
} from './cloud-session';
import {
  buildReMindApiUrl,
  credentialScope,
  getReMindServiceConfig,
  type ReMindServiceConfig,
} from './service-contract';

const CLOUD_SESSION_KEY = 'remind.cloud.session';
const REQUEST_TIMEOUT_MS = 10_000;
const refreshes = new Map<string, Promise<CloudSession>>();

export type CloudDeviceRegistration = {
  platform: 'android' | 'ios' | 'unknown';
  displayName?: string;
  appVersion?: string;
};

export type CreatedCloudAccount = CloudSession & {
  recoveryCode: string;
};

export async function registerCloudAccount(
  registration: CloudDeviceRegistration,
): Promise<CreatedCloudAccount> {
  const service = requireHostedService();
  const payload = await postJson(
    buildReMindApiUrl(service, 'auth/register'),
    registration,
  );
  if (!isCreatedAccount(payload)) {
    throw new Error('Cloud registration returned an invalid response');
  }
  await saveCloudSession(service, payload);
  return payload;
}

export async function recoverCloudAccount(
  recoveryCode: string,
  registration: CloudDeviceRegistration,
): Promise<CloudSession> {
  const service = requireHostedService();
  const payload = await postJson(buildReMindApiUrl(service, 'auth/recover'), {
    ...registration,
    recoveryCode,
  });
  if (!isCloudSession(payload)) {
    throw new Error('Cloud recovery returned an invalid response');
  }
  await saveCloudSession(service, payload);
  return payload;
}

export async function getCloudAccessToken(): Promise<string | null> {
  const service = getReMindServiceConfig();
  if (!service || service.mode !== 'hosted') return null;
  const session = await loadCloudSession(service);
  if (!session) return null;
  const current = shouldRefreshCloudSession(session)
    ? await refreshCloudSession(service, session)
    : session;
  return current.accessToken;
}

export async function clearCloudSession(): Promise<void> {
  const service = getReMindServiceConfig();
  if (!service || service.mode !== 'hosted') return;
  await SecureStore.deleteItemAsync(sessionStorageKey(service));
}

async function refreshCloudSession(
  service: ReMindServiceConfig,
  session: CloudSession,
): Promise<CloudSession> {
  const key = credentialScope(service);
  const existing = refreshes.get(key);
  if (existing) return existing;

  const refresh = postJson(buildReMindApiUrl(service, 'auth/refresh'), {
    deviceId: session.deviceId,
    deviceSecret: session.deviceSecret,
  })
    .then(async (payload) => {
      if (!isCloudSession(payload)) {
        throw new Error('Cloud session refresh returned an invalid response');
      }
      await saveCloudSession(service, payload);
      return payload;
    })
    .finally(() => {
      refreshes.delete(key);
    });
  refreshes.set(key, refresh);
  return refresh;
}

async function loadCloudSession(
  service: ReMindServiceConfig,
): Promise<CloudSession | null> {
  const stored = await SecureStore.getItemAsync(sessionStorageKey(service));
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as unknown;
    return isCloudSession(value) ? value : null;
  } catch {
    return null;
  }
}

async function saveCloudSession(
  service: ReMindServiceConfig,
  session: CloudSession,
): Promise<void> {
  await SecureStore.setItemAsync(
    sessionStorageKey(service),
    JSON.stringify(session),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
}

function sessionStorageKey(service: ReMindServiceConfig): string {
  const scope = credentialScope(service);
  let hash = 5381;
  for (let index = 0; index < scope.length; index += 1) {
    hash = (hash * 33) ^ scope.charCodeAt(index);
  }
  return `${CLOUD_SESSION_KEY}.${(hash >>> 0).toString(16)}`;
}

function requireHostedService(): ReMindServiceConfig {
  const service = getReMindServiceConfig();
  if (!service || service.mode !== 'hosted') {
    throw new Error('Hosted ReMind service is not configured');
  }
  return service;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new Error(
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : 'Cloud authentication failed',
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function isCreatedAccount(value: unknown): value is CreatedCloudAccount {
  return (
    isCloudSession(value) &&
    typeof (value as CloudSession & { recoveryCode?: unknown }).recoveryCode ===
      'string'
  );
}

function isCloudSession(value: unknown): value is CloudSession {
  return (
    isRecord(value) &&
    typeof value.userId === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.deviceSecret === 'string' &&
    typeof value.accessToken === 'string' &&
    typeof value.accessTokenExpiresAt === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

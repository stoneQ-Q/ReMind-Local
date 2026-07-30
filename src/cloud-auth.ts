import * as SecureStore from 'expo-secure-store';

import {
  serializeCloudSession,
  shouldRefreshCloudSession,
  type CloudSession,
} from './cloud-session';
import {
  buildReMindApiUrl,
  credentialScope,
  getReMindServiceConfigForMode,
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

export type CloudDevice = {
  id: string;
  displayName: string | null;
  platform: CloudDeviceRegistration['platform'];
  appVersion: string | null;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
};

export type CloudAccountOverview = {
  userId: string;
  createdAt: string;
  devices: CloudDevice[];
};

export function isHostedCloudConfigured(): boolean {
  return getReMindServiceConfigForMode('cloud') !== null;
}

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
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) return null;
  const session = await loadCloudSession(service);
  if (!session) return null;
  const current = shouldRefreshCloudSession(session)
    ? await refreshCloudSession(service, session)
    : session;
  return current.accessToken;
}

export async function getCloudAccountOverview(): Promise<CloudAccountOverview | null> {
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) return null;
  try {
    const accessToken = await getCloudAccessToken();
    if (!accessToken) return null;
    const [profile, devicePayload] = await Promise.all([
      authorizedJson(buildReMindApiUrl(service, 'users/me'), accessToken),
      authorizedJson(buildReMindApiUrl(service, 'devices'), accessToken),
    ]);
    if (
      !isRecord(profile) ||
      typeof profile.id !== 'string' ||
      typeof profile.createdAt !== 'string' ||
      !isRecord(devicePayload) ||
      !Array.isArray(devicePayload.devices)
    ) {
      throw new Error('invalid_cloud_account_response');
    }
    const devices = devicePayload.devices.filter(isCloudDevice);
    if (devices.length !== devicePayload.devices.length) {
      throw new Error('invalid_cloud_account_response');
    }
    return {
      userId: profile.id,
      createdAt: profile.createdAt,
      devices,
    };
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401) {
      await clearCloudSession();
      return null;
    }
    throw error;
  }
}

export async function revokeCloudDevice(deviceId: string): Promise<{
  current: boolean;
}> {
  const service = requireHostedService();
  const accessToken = await getCloudAccessToken();
  if (!accessToken) throw new Error('cloud_session_missing');
  const payload = await authorizedJson(
    buildReMindApiUrl(service, `devices/${encodeURIComponent(deviceId)}`),
    accessToken,
    'DELETE',
  );
  if (
    !isRecord(payload) ||
    payload.id !== deviceId ||
    typeof payload.current !== 'boolean'
  ) {
    throw new Error('invalid_cloud_device_response');
  }
  if (payload.current) await clearCloudSession();
  return { current: payload.current };
}

export async function clearCloudSession(): Promise<void> {
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) return;
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
    serializeCloudSession(session),
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
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) {
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
    if (!response.ok) throw CloudApiError.fromResponse(response.status, payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function authorizedJson(
  url: string,
  accessToken: string,
  method = 'GET',
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw CloudApiError.fromResponse(response.status, payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  static fromResponse(status: number, payload: unknown): CloudApiError {
    return new CloudApiError(
      status,
      isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : 'cloud_request_failed',
    );
  }
}

function isCloudDevice(value: unknown): value is CloudDevice {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (typeof value.displayName === 'string' || value.displayName === null) &&
    (value.platform === 'android' ||
      value.platform === 'ios' ||
      value.platform === 'unknown') &&
    (typeof value.appVersion === 'string' || value.appVersion === null) &&
    typeof value.current === 'boolean' &&
    typeof value.createdAt === 'string' &&
    typeof value.lastSeenAt === 'string'
  );
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

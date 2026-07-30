import { clearCloudSession, getCloudAccessToken } from './cloud-auth';
import {
  buildReMindApiUrl,
  getReMindServiceConfigForMode,
} from './service-contract';

const REQUEST_TIMEOUT_MS = 10_000;

export type CloudAiProvider = 'deepseek' | 'zhipu';
export type CloudAiMode =
  | 'disabled'
  | 'bring_your_own_key'
  | 'managed';

export type CloudAiSettings = {
  mode: CloudAiMode;
  credentials: Array<{
    provider: CloudAiProvider;
    maskedSuffix: string;
    updatedAt: string;
  }>;
};

export async function getCloudAiSettings(): Promise<CloudAiSettings> {
  return requestAiSettings('ai/settings');
}

export async function updateCloudAiMode(
  mode: Exclude<CloudAiMode, 'managed'>,
): Promise<CloudAiSettings> {
  return requestAiSettings('ai/settings', {
    method: 'PUT',
    body: JSON.stringify({ mode }),
  });
}

export async function saveCloudAiCredential(
  provider: CloudAiProvider,
  apiKey: string,
): Promise<CloudAiSettings> {
  return requestAiSettings(`ai/credentials/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  });
}

export async function deleteCloudAiCredential(
  provider: CloudAiProvider,
): Promise<CloudAiSettings> {
  return requestAiSettings(`ai/credentials/${provider}`, {
    method: 'DELETE',
  });
}

async function requestAiSettings(
  path: string,
  init: RequestInit = {},
): Promise<CloudAiSettings> {
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) throw new CloudAiSettingsError('cloud_not_configured');
  const accessToken = await getCloudAccessToken();
  if (!accessToken) throw new CloudAiSettingsError('cloud_session_missing');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(buildReMindApiUrl(service, path), {
      ...init,
      headers,
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      if (response.status === 401) await clearCloudSession();
      throw new CloudAiSettingsError(cloudErrorCode(payload), response.status);
    }
    if (!isCloudAiSettings(payload)) {
      throw new CloudAiSettingsError('invalid_ai_settings_response');
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export class CloudAiSettingsError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

function cloudErrorCode(payload: unknown): string {
  return isRecord(payload) && typeof payload.error === 'string'
    ? payload.error
    : 'cloud_request_failed';
}

function isCloudAiSettings(value: unknown): value is CloudAiSettings {
  if (
    !isRecord(value) ||
    (value.mode !== 'disabled' &&
      value.mode !== 'bring_your_own_key' &&
      value.mode !== 'managed') ||
    !Array.isArray(value.credentials)
  ) {
    return false;
  }
  return value.credentials.every(
    (credential) =>
      isRecord(credential) &&
      (credential.provider === 'deepseek' ||
        credential.provider === 'zhipu') &&
      typeof credential.maskedSuffix === 'string' &&
      credential.maskedSuffix.length === 4 &&
      typeof credential.updatedAt === 'string',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

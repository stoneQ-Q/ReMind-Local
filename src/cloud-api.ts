import { clearCloudSession, getCloudAccessToken } from './cloud-auth';
import {
  buildReMindApiUrl,
  getReMindServiceConfigForMode,
} from './service-contract';

const DEFAULT_TIMEOUT_MS = 10_000;

export async function requestCloudJson(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) throw new CloudApiRequestError('cloud_not_configured');
  const accessToken = await getCloudAccessToken();
  if (!accessToken) throw new CloudApiRequestError('cloud_session_missing');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      throw new CloudApiRequestError(cloudErrorCode(payload), response.status);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestCloud(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const service = getReMindServiceConfigForMode('cloud');
  if (!service) throw new CloudApiRequestError('cloud_not_configured');
  const accessToken = await getCloudAccessToken();
  if (!accessToken) throw new CloudApiRequestError('cloud_session_missing');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(buildReMindApiUrl(service, path), {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (response.status === 401) await clearCloudSession();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export class CloudApiRequestError extends Error {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

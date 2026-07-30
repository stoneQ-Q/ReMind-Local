import {
  CloudApiRequestError,
  requestCloudJson,
} from './cloud-api';

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
  const payload = await requestCloudJson(path, init);
  if (!isCloudAiSettings(payload)) {
    throw new CloudApiRequestError('invalid_ai_settings_response');
  }
  return payload;
}

export { CloudApiRequestError as CloudAiSettingsError };

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

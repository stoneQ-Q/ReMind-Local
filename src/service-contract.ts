export const REMIND_API_VERSION = 'v1' as const;

export type ReMindServiceMode = 'self-hosted' | 'hosted';
export type ReMindAiMode = 'disabled' | 'bring-your-own-key' | 'managed';
export type ReMindApiRouteStyle = 'legacy' | 'versioned';

export type ReMindServiceConfig = {
  mode: ReMindServiceMode;
  baseUrl: string;
  apiVersion: typeof REMIND_API_VERSION;
  routeStyle: ReMindApiRouteStyle;
};

export type ReMindOwnedResource =
  | 'device'
  | 'wechat-connection'
  | 'note'
  | 'job'
  | 'file'
  | 'api-credential'
  | 'billing-account'
  | 'ledger-entry';

export type ReMindResourceOwner = {
  userId: string;
  resourceType: ReMindOwnedResource;
  resourceId: string;
};

export type ReMindServiceCapabilities = {
  accounts: boolean;
  cloudSync: boolean;
  managedAi: boolean;
  bringYourOwnKey: boolean;
  billing: boolean;
  asynchronousJobs: boolean;
};

const LEGACY_API_PREFIX = '/api';

export function getReMindServiceConfig(): ReMindServiceConfig | null {
  const baseUrl = normalizeBaseUrl(
    process.env.EXPO_PUBLIC_REMIND_API_URL ?? '',
  );
  if (!baseUrl) return null;

  return {
    mode:
      process.env.EXPO_PUBLIC_REMIND_SERVICE_MODE === 'hosted'
        ? 'hosted'
        : 'self-hosted',
    baseUrl,
    apiVersion: REMIND_API_VERSION,
    routeStyle:
      process.env.EXPO_PUBLIC_REMIND_API_VERSION === REMIND_API_VERSION
        ? 'versioned'
        : 'legacy',
  };
}

export function buildReMindApiUrl(
  config: ReMindServiceConfig,
  resourcePath: string,
): string {
  const prefix =
    config.routeStyle === 'versioned'
      ? `/api/${config.apiVersion}`
      : LEGACY_API_PREFIX;
  return `${config.baseUrl}${prefix}/${resourcePath.replace(/^\/+/, '')}`;
}

export function credentialScope(config: ReMindServiceConfig): string {
  if (config.routeStyle === 'legacy') return config.baseUrl;
  return `${config.mode}:${config.baseUrl}:${config.apiVersion}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

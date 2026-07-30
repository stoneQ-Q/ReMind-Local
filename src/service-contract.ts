export const REMIND_API_VERSION = 'v1' as const;

export type ReMindServiceMode = 'self-hosted' | 'hosted';
export type ReMindAppMode = 'local' | 'cloud';
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
let activeModeOverride: ReMindAppMode | null = null;

export function getReMindServiceConfig(): ReMindServiceConfig | null {
  return getReMindServiceConfigForMode(getActiveReMindAppMode());
}

export function getReMindServiceConfigForMode(
  mode: ReMindAppMode,
): ReMindServiceConfig | null {
  const legacyBaseUrl = normalizeBaseUrl(
    process.env.EXPO_PUBLIC_REMIND_API_URL ?? '',
  );
  const legacyHosted =
    process.env.EXPO_PUBLIC_REMIND_SERVICE_MODE === 'hosted';
  const explicitBaseUrl = normalizeBaseUrl(
    mode === 'local'
      ? process.env.EXPO_PUBLIC_REMIND_LOCAL_API_URL ?? ''
      : process.env.EXPO_PUBLIC_REMIND_CLOUD_API_URL ?? '',
  );
  const baseUrl =
    explicitBaseUrl ||
    (mode === 'local' && !legacyHosted
      ? legacyBaseUrl
      : mode === 'cloud' && legacyHosted
        ? legacyBaseUrl
        : '');
  if (!baseUrl) return null;

  return {
    mode: mode === 'cloud' ? 'hosted' : 'self-hosted',
    baseUrl,
    apiVersion: REMIND_API_VERSION,
    routeStyle:
      mode === 'cloud' &&
      (Boolean(explicitBaseUrl) ||
        process.env.EXPO_PUBLIC_REMIND_API_VERSION === REMIND_API_VERSION)
        ? 'versioned'
        : 'legacy',
  };
}

export function getActiveReMindAppMode(): ReMindAppMode {
  const fallback = defaultReMindAppMode();
  if (
    activeModeOverride &&
    getReMindServiceConfigForMode(activeModeOverride)
  ) {
    return activeModeOverride;
  }
  return fallback;
}

export function setActiveReMindAppMode(
  mode: ReMindAppMode | null,
): void {
  activeModeOverride = mode;
}

export function getAvailableReMindAppModes(): Record<
  ReMindAppMode,
  boolean
> {
  return {
    local: getReMindServiceConfigForMode('local') !== null,
    cloud: getReMindServiceConfigForMode('cloud') !== null,
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

function defaultReMindAppMode(): ReMindAppMode {
  if (getReMindServiceConfigForMode('local')) return 'local';
  if (getReMindServiceConfigForMode('cloud')) return 'cloud';
  return 'local';
}

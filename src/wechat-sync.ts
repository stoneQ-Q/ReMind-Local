import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  createImportedNote,
  getImportedSourceVersions,
  recordWechatSyncFailure,
  recordWechatSyncSuccess,
} from './database';
import {
  buildReMindApiUrl,
  credentialScope,
  getReMindServiceConfig,
  type ReMindServiceConfig,
} from './service-contract';
import {
  wechatDeviceIdStorageKey,
  wechatDeviceSecretStorageKey,
} from './persistence-contract';
import { requestCloud, requestCloudJson } from './cloud-api';
import { runSingleWechatSync } from './wechat-sync-guard';
import { xiaoyuzhouUserIntent } from './xiaoyuzhou';

export type WechatReplyMode = 'first' | 'always' | 'silent';

export type WechatLoginSession = {
  sessionToken: string;
  qrImageDataUrl: string;
  expiresAt: string;
};

export type WechatLoginCheck = {
  status:
    | 'waiting'
    | 'scanned'
    | 'verification_required'
    | 'connected'
    | 'expired'
    | 'blocked'
    | 'conflict';
  sessionToken: string | null;
};

export type WechatConnection = {
  configured: boolean;
  bound: boolean;
  bindingCode: string | null;
  expiresAt: string | null;
  replyMode: WechatReplyMode;
  gatewayOnline: boolean;
  localWhisperAvailable: boolean;
  aiAvailable: boolean;
  visionAvailable: boolean;
};

export type WechatProcessingLink = {
  messageId: string;
  title: string;
  url: string;
  stage: string;
  status: 'pending' | 'failed';
  current: number;
  total: number;
  provider: string | null;
  estimatedCostMicros: number | null;
  durationSeconds: number | null;
  errorCode: string | null;
  cloudCostApproved: boolean;
  costLimitMicros: number | null;
  updatedAt: string;
};

type StoredDevice = {
  deviceId: string;
  deviceSecret: string;
};

type InboxMessage = {
  msgId: string;
  type: string;
  content: string;
  linkUrl: string | null;
  userContext: string | null;
  pageTitle: string | null;
  pageSite: string | null;
  pageText: string | null;
  createdAt: string;
};

export function isWechatApiConfigured(): boolean {
  return getReMindServiceConfig() !== null;
}

export async function getWechatConnection(
  createIfMissing: boolean,
): Promise<WechatConnection> {
  const service = getReMindServiceConfig();
  if (!service) {
    return {
      configured: false,
      bound: false,
      bindingCode: null,
      expiresAt: null,
      replyMode: 'first',
      gatewayOnline: false,
      localWhisperAvailable: false,
      aiAvailable: false,
      visionAvailable: false,
    };
  }

  if (service.mode === 'hosted') {
    const status = (await requestCloudJson(
      'wechat/status',
    )) as WechatConnection;
    if (!status.bound && createIfMissing) {
      const binding = (await requestCloudJson('wechat/binding-code', {
        method: 'POST',
      })) as { bindingCode: string; expiresAt: string };
      return { ...status, ...binding };
    }
    return status;
  }

  let device = await getStoredDevice(service);
  if (!device && createIfMissing) {
    device = await registerDevice(service);
  }
  if (!device) {
    return {
      configured: true,
      bound: false,
      bindingCode: null,
      expiresAt: null,
      replyMode: 'first',
      gatewayOnline: false,
      localWhisperAvailable: false,
      aiAvailable: false,
      visionAvailable: false,
    };
  }

  const response = await apiRequest(
    deviceApiUrl(service, device.deviceId, 'status'),
    {
      headers: { Authorization: `Bearer ${device.deviceSecret}` },
    },
  );
  if (!response.ok) throw new Error('Unable to load WeChat binding status');
  let status = (await response.json()) as {
    bound: boolean;
    bindingCode: string;
    expiresAt: string;
    replyMode: WechatReplyMode;
    gatewayOnline?: boolean;
    localWhisperAvailable?: boolean;
    aiAvailable?: boolean;
    visionAvailable?: boolean;
  };
  if (!status.bound && Date.parse(status.expiresAt) <= Date.now()) {
    const refresh = await apiRequest(
      deviceApiUrl(service, device.deviceId, 'binding-code'),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${device.deviceSecret}` },
      },
    );
    if (!refresh.ok) throw new Error('Unable to refresh WeChat binding code');
    const binding = (await refresh.json()) as {
      bindingCode: string;
      expiresAt: string;
    };
    status = { ...status, ...binding };
  }
  return {
    configured: true,
    bound: status.bound,
    bindingCode: status.bindingCode,
    expiresAt: status.expiresAt,
    replyMode: status.replyMode,
    gatewayOnline: status.gatewayOnline === true,
    localWhisperAvailable: status.localWhisperAvailable === true,
    aiAvailable: status.aiAvailable === true,
    visionAvailable: status.visionAvailable === true,
  };
}

export async function startCloudWechatLogin(): Promise<WechatLoginSession> {
  const payload = await requestCloudJson('wechat/login', { method: 'POST' });
  if (
    !isRecord(payload) ||
    typeof payload.sessionToken !== 'string' ||
    !payload.sessionToken ||
    typeof payload.qrImageDataUrl !== 'string' ||
    !payload.qrImageDataUrl.startsWith('data:image/png;base64,') ||
    typeof payload.expiresAt !== 'string'
  ) {
    throw new Error('invalid_wechat_login_response');
  }
  return {
    sessionToken: payload.sessionToken,
    qrImageDataUrl: payload.qrImageDataUrl,
    expiresAt: payload.expiresAt,
  };
}

export async function checkCloudWechatLogin(
  sessionToken: string,
  verificationCode?: string,
): Promise<WechatLoginCheck> {
  const payload = await requestCloudJson(
    'wechat/login/check',
    {
      method: 'POST',
      body: JSON.stringify({
        sessionToken,
        ...(verificationCode ? { verificationCode } : {}),
      }),
    },
    45_000,
  );
  if (
    !isRecord(payload) ||
    !isWechatLoginStatus(payload.status) ||
    !(
      typeof payload.sessionToken === 'string' ||
      payload.sessionToken === null
    )
  ) {
    throw new Error('invalid_wechat_login_response');
  }
  return {
    status: payload.status,
    sessionToken: payload.sessionToken,
  };
}

export async function updateWechatReplyMode(
  replyMode: WechatReplyMode,
): Promise<void> {
  const service = getReMindServiceConfig();
  if (service?.mode === 'hosted') {
    await requestCloudJson('wechat/reply-mode', {
      method: 'PUT',
      body: JSON.stringify({ replyMode }),
    });
    return;
  }
  const device =
    service?.mode === 'self-hosted' ? await getStoredDevice(service) : null;
  if (!service || !device) throw new Error('WeChat is not connected');

  const response = await apiRequest(
    deviceApiUrl(service, device.deviceId, 'reply-mode'),
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${device.deviceSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ replyMode }),
    },
  );
  if (!response.ok) throw new Error('Unable to update WeChat reply mode');
}

export async function requestAuthenticatedDeviceApi(
  action: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const service = getReMindServiceConfig();
  if (service?.mode === 'hosted') {
    return requestCloud(`organize/${action}`, init, timeoutMs);
  }
  if (!service) {
    throw new Error('Local ReMind service is not active');
  }
  let device = await getStoredDevice(service);
  if (!device) device = await registerDevice(service);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${device.deviceSecret}`);
  return apiRequest(
    deviceApiUrl(service, device.deviceId, action),
    { ...init, headers },
    timeoutMs,
  );
}

export async function syncWechatInbox(
  db: SQLiteDatabase,
): Promise<number> {
  try {
    const imported = await runSingleWechatSync(db, () => syncWechatInboxOnce(db));
    await recordWechatSyncSuccess(db);
    return imported;
  } catch (error) {
    await recordWechatSyncFailure(
      db,
      error instanceof Error ? error.message : 'wechat_sync_failed',
    ).catch(() => undefined);
    throw error;
  }
}

async function syncWechatInboxOnce(
  db: SQLiteDatabase,
): Promise<number> {
  const service = getReMindServiceConfig();
  if (service?.mode === 'hosted') {
    const manifest = (await requestCloudJson('wechat/capture-manifest')) as {
      captures?: Array<{ id: string; updatedAt: string }>;
    };
    const captures = manifest.captures ?? [];
    const sourceKeys = captures.map((capture) => `cloud-wechat:${capture.id}`);
    const localVersions = await getImportedSourceVersions(db, sourceKeys);
    const pending = captures
      .filter(
        (capture) =>
          normalizedSyncTimestamp(
            localVersions.get(`cloud-wechat:${capture.id}`) ?? null,
          ) !== normalizedSyncTimestamp(capture.updatedAt),
      )
      .slice(0, 5);
    if (__DEV__) {
      console.info('[wechat-sync] cloud captures pending', pending.length);
    }
    let importedCount = 0;
    for (const item of pending) {
      const payload = (await requestCloudJson(
        `wechat/captures/${encodeURIComponent(item.id)}`,
        {},
        30_000,
      )) as {
        capture?: {
        id: string;
        content: string;
        sourceUrl: string | null;
        userContext: string | null;
        pageTitle: string | null;
        pageSite: string | null;
        pageText: string | null;
        createdAt: string;
          updatedAt: string;
        };
      };
      const message = payload.capture;
      if (!message) continue;
      const created = await createImportedNote(
        db,
        message.content,
        `cloud-wechat:${message.id}`,
        {
          sourceUrl: message.sourceUrl,
          userContext: xiaoyuzhouUserIntent(message.userContext),
          sourcePageTitle: message.pageTitle,
          sourcePageSite: message.pageSite,
          sourcePageText: message.pageText,
          createdAt: message.createdAt,
          sourceUpdatedAt: message.updatedAt,
        },
      );
      if (created) importedCount += 1;
    }
    if (__DEV__) {
      console.info('[wechat-sync] cloud captures imported', importedCount);
    }
    return importedCount;
  }
  const device =
    service?.mode === 'self-hosted' ? await getStoredDevice(service) : null;
  if (!service || !device) return 0;

  const response = await apiRequest(
    deviceApiUrl(service, device.deviceId, 'inbox'),
    {
      headers: { Authorization: `Bearer ${device.deviceSecret}` },
    },
  );
  if (!response.ok) throw new Error('Unable to load WeChat inbox');
  const payload = (await response.json()) as { messages: InboxMessage[] };
  const acknowledgedIds: string[] = [];
  let importedCount = 0;

  for (const message of payload.messages) {
    const created = await createImportedNote(
      db,
      message.content,
      `wechat:${message.msgId}`,
      {
        sourceUrl: message.linkUrl,
        userContext: xiaoyuzhouUserIntent(message.userContext),
        sourcePageTitle: message.pageTitle,
        sourcePageSite: message.pageSite,
        sourcePageText: message.pageText,
        createdAt: message.createdAt,
      },
    );
    acknowledgedIds.push(message.msgId);
    if (created) importedCount += 1;
  }

  if (acknowledgedIds.length) {
    const acknowledge = await apiRequest(
      deviceApiUrl(service, device.deviceId, 'ack'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${device.deviceSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageIds: acknowledgedIds }),
      },
    );
    if (!acknowledge.ok) throw new Error('Unable to acknowledge WeChat inbox');
  }

  return importedCount;
}

function normalizedSyncTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export async function getWechatProcessingLinks(): Promise<
  WechatProcessingLink[]
> {
  if (getReMindServiceConfig()?.mode === 'hosted') return [];
  if (!isWechatApiConfigured()) return [];
  const response = await requestAuthenticatedDeviceApi('processing-links');
  if (!response.ok) throw new Error('Unable to load processing links');
  const payload = (await response.json()) as {
    links?: WechatProcessingLink[];
  };
  return Array.isArray(payload.links) ? payload.links : [];
}

export async function retryWechatProcessingLink(
  messageId: string,
): Promise<void> {
  const response = await requestAuthenticatedDeviceApi('link-retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
  if (!response.ok) throw new Error('Unable to retry processing link');
}

export async function approveWechatProcessingCost(
  messageId: string,
): Promise<void> {
  const response = await requestAuthenticatedDeviceApi('link-approve-cost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
  if (!response.ok) throw new Error('Unable to approve cloud transcription cost');
}

async function registerDevice(
  service: ReMindServiceConfig,
): Promise<StoredDevice> {
  const response = await apiRequest(buildReMindApiUrl(service, 'devices'), {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Unable to register this device');
  const payload = (await response.json()) as {
    deviceId: string;
    deviceSecret: string;
  };
  const scope = credentialScope(service);
  await Promise.all([
    SecureStore.setItemAsync(
      wechatDeviceIdStorageKey(scope),
      payload.deviceId,
    ),
    SecureStore.setItemAsync(
      wechatDeviceSecretStorageKey(scope),
      payload.deviceSecret,
    ),
  ]);
  return {
    deviceId: payload.deviceId,
    deviceSecret: payload.deviceSecret,
  };
}

async function getStoredDevice(
  service: ReMindServiceConfig,
): Promise<StoredDevice | null> {
  const scope = credentialScope(service);
  const [deviceId, deviceSecret] = await Promise.all([
    SecureStore.getItemAsync(wechatDeviceIdStorageKey(scope)),
    SecureStore.getItemAsync(wechatDeviceSecretStorageKey(scope)),
  ]);
  return deviceId && deviceSecret ? { deviceId, deviceSecret } : null;
}

async function apiRequest(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function deviceApiUrl(
  service: ReMindServiceConfig,
  deviceId: string,
  action: string,
): string {
  return buildReMindApiUrl(
    service,
    `devices/${encodeURIComponent(deviceId)}/${action}`,
  );
}

function isWechatLoginStatus(value: unknown): value is WechatLoginCheck['status'] {
  return (
    value === 'waiting' ||
    value === 'scanned' ||
    value === 'verification_required' ||
    value === 'connected' ||
    value === 'expired' ||
    value === 'blocked' ||
    value === 'conflict'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

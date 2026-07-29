import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';

import { createImportedNote } from './database';

const DEVICE_ID_KEY = 'remind.wechat.device-id';
const DEVICE_SECRET_KEY = 'remind.wechat.device-secret';

export type WechatReplyMode = 'first' | 'always' | 'silent';

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
  return Boolean(apiBaseUrl());
}

export async function getWechatConnection(
  createIfMissing: boolean,
): Promise<WechatConnection> {
  const baseUrl = apiBaseUrl();
  if (!baseUrl) {
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

  let device = await getStoredDevice(baseUrl);
  if (!device && createIfMissing) {
    device = await registerDevice(baseUrl);
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
    `${baseUrl}/api/devices/${encodeURIComponent(device.deviceId)}/status`,
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
      `${baseUrl}/api/devices/${encodeURIComponent(
        device.deviceId,
      )}/binding-code`,
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

export async function updateWechatReplyMode(
  replyMode: WechatReplyMode,
): Promise<void> {
  const baseUrl = apiBaseUrl();
  const device = baseUrl ? await getStoredDevice(baseUrl) : null;
  if (!baseUrl || !device) throw new Error('WeChat is not connected');

  const response = await apiRequest(
    `${baseUrl}/api/devices/${encodeURIComponent(device.deviceId)}/reply-mode`,
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
  const baseUrl = apiBaseUrl();
  if (!baseUrl) throw new Error('ReMind service is not configured');
  let device = await getStoredDevice(baseUrl);
  if (!device) device = await registerDevice(baseUrl);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${device.deviceSecret}`);
  return apiRequest(
    `${baseUrl}/api/devices/${encodeURIComponent(device.deviceId)}/${action}`,
    { ...init, headers },
    timeoutMs,
  );
}

export async function syncWechatInbox(
  db: SQLiteDatabase,
): Promise<number> {
  const baseUrl = apiBaseUrl();
  const device = baseUrl ? await getStoredDevice(baseUrl) : null;
  if (!baseUrl || !device) return 0;

  const response = await apiRequest(
    `${baseUrl}/api/devices/${encodeURIComponent(device.deviceId)}/inbox`,
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
        userContext: message.userContext,
        sourcePageTitle: message.pageTitle,
        sourcePageSite: message.pageSite,
        sourcePageText: message.pageText,
      },
    );
    acknowledgedIds.push(message.msgId);
    if (created) importedCount += 1;
  }

  if (acknowledgedIds.length) {
    const acknowledge = await apiRequest(
      `${baseUrl}/api/devices/${encodeURIComponent(device.deviceId)}/ack`,
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

export async function getWechatProcessingLinks(): Promise<
  WechatProcessingLink[]
> {
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

async function registerDevice(baseUrl: string): Promise<StoredDevice> {
  const response = await apiRequest(`${baseUrl}/api/devices`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Unable to register this device');
  const payload = (await response.json()) as {
    deviceId: string;
    deviceSecret: string;
  };
  await Promise.all([
    SecureStore.setItemAsync(scopedKey(DEVICE_ID_KEY, baseUrl), payload.deviceId),
    SecureStore.setItemAsync(
      scopedKey(DEVICE_SECRET_KEY, baseUrl),
      payload.deviceSecret,
    ),
  ]);
  return {
    deviceId: payload.deviceId,
    deviceSecret: payload.deviceSecret,
  };
}

async function getStoredDevice(baseUrl: string): Promise<StoredDevice | null> {
  const [deviceId, deviceSecret] = await Promise.all([
    SecureStore.getItemAsync(scopedKey(DEVICE_ID_KEY, baseUrl)),
    SecureStore.getItemAsync(scopedKey(DEVICE_SECRET_KEY, baseUrl)),
  ]);
  return deviceId && deviceSecret ? { deviceId, deviceSecret } : null;
}

function scopedKey(key: string, baseUrl: string): string {
  let hash = 5381;
  for (let index = 0; index < baseUrl.length; index += 1) {
    hash = (hash * 33) ^ baseUrl.charCodeAt(index);
  }
  return `${key}.${(hash >>> 0).toString(16)}`;
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

function apiBaseUrl(): string {
  return (process.env.EXPO_PUBLIC_REMIND_API_URL ?? '').replace(/\/+$/, '');
}

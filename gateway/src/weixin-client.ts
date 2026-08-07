import { randomBytes, randomUUID } from 'node:crypto';

import type {
  LoginStatus,
  UpdatesResponse,
  WeixinMessage,
} from './types.js';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.6';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

type QrResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

function baseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: 'ReMind/0.1.0',
  };
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  };
}

function authenticatedHeaders(token?: string): Record<string, string> {
  const value = randomBytes(4).readUInt32BE(0);
  return {
    ...commonHeaders(),
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(value), 'utf8').toString('base64'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function requestText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  token: string | undefined,
  timeoutMs: number,
): Promise<T> {
  const text = await requestText(
    endpoint(baseUrl, path),
    {
      method: 'POST',
      headers: authenticatedHeaders(token),
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  return JSON.parse(text) as T;
}

export async function requestLoginQr(): Promise<QrResponse> {
  return postJson<QrResponse>(
    FIXED_BASE_URL,
    'ilink/bot/get_bot_qrcode?bot_type=3',
    { local_token_list: [] },
    undefined,
    15_000,
  );
}

export async function pollLoginStatus(
  qrcode: string,
  baseUrl = FIXED_BASE_URL,
  verifyCode?: string,
): Promise<LoginStatus> {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) query.set('verify_code', verifyCode);
  const text = await requestText(
    endpoint(
      baseUrl,
      `ilink/bot/get_qrcode_status?${query.toString()}`,
    ),
    { method: 'GET', headers: commonHeaders() },
    40_000,
  );
  return JSON.parse(text) as LoginStatus;
}

export async function notifyStart(
  baseUrl: string,
  token: string,
): Promise<void> {
  await postJson(
    baseUrl,
    'ilink/bot/msg/notifystart',
    { base_info: baseInfo() },
    token,
    15_000,
  );
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
  timeoutMs: number,
): Promise<UpdatesResponse> {
  try {
    return await postJson<UpdatesResponse>(
      baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: baseInfo() },
      token,
      Math.max(timeoutMs, 40_000),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: cursor };
    }
    throw error;
  }
}

export async function sendText(
  baseUrl: string,
  token: string,
  incoming: WeixinMessage,
  text: string,
): Promise<void> {
  const response = await postJson<{ ret?: number; errmsg?: string }>(
    baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: incoming.from_user_id,
        client_id: `remind-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: incoming.context_token,
      },
      base_info: baseInfo(),
    },
    token,
    15_000,
  );
  if (response.ret && response.ret !== 0) {
    throw new Error(
      `sendMessage ret=${response.ret}: ${response.errmsg ?? 'unknown error'}`,
    );
  }
}

export function normalizedBaseUrl(value?: string): string {
  if (!value) return FIXED_BASE_URL;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

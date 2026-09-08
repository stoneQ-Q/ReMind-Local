import QRCode from 'qrcode';

import type { CredentialCipher } from './credential-cipher.js';
import {
  validateWechatCredentials,
  type WechatProtocolCredentials,
} from './wechat-protocol.js';

const WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com/';
const CHANNEL_VERSION = '2.4.6';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const LOGIN_TTL_MS = 10 * 60_000;
const LOGIN_PROVIDER = 'wechat-login-session';

type WechatLoginPayload = {
  userId: string;
  qrcode: string;
  pollingBaseUrl: string;
  expiresAt: string;
};

type WechatLoginStatus = {
  status:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
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
  credentials?: WechatProtocolCredentials;
};

export async function startWechatLogin(
  cipher: CredentialCipher,
  userId: string,
): Promise<{
  sessionToken: string;
  qrImageDataUrl: string;
  expiresAt: string;
}> {
  const response = await wechatRequest<{
    qrcode?: unknown;
    qrcode_img_content?: unknown;
  }>(new URL('ilink/bot/get_bot_qrcode?bot_type=3', WECHAT_BASE_URL), {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (
    typeof response.qrcode !== 'string' ||
    !response.qrcode ||
    typeof response.qrcode_img_content !== 'string' ||
    !response.qrcode_img_content
  ) {
    throw new Error('wechat_login_invalid_qr_response');
  }
  const expiresAt = new Date(Date.now() + LOGIN_TTL_MS).toISOString();
  const sessionToken = sealLoginPayload(cipher, {
    userId,
    qrcode: response.qrcode,
    pollingBaseUrl: WECHAT_BASE_URL,
    expiresAt,
  });
  const qrImageDataUrl = await QRCode.toDataURL(response.qrcode_img_content, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 480,
  });
  return { sessionToken, qrImageDataUrl, expiresAt };
}

export async function checkWechatLogin(
  cipher: CredentialCipher,
  userId: string,
  sessionToken: string,
  verificationCode?: string,
): Promise<WechatLoginCheck> {
  const payload = openLoginPayload(cipher, userId, sessionToken);
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    return { status: 'expired', sessionToken: null };
  }
  const query = new URLSearchParams({ qrcode: payload.qrcode });
  if (verificationCode) query.set('verify_code', verificationCode);
  const status = await wechatRequest<WechatLoginStatus>(
    new URL(`ilink/bot/get_qrcode_status?${query.toString()}`, payload.pollingBaseUrl),
    { method: 'GET', headers: statusHeaders() },
    40_000,
  );

  if (status.status === 'confirmed') {
    const credentials = validateWechatCredentials({
      botToken: status.bot_token ?? '',
      botId: status.ilink_bot_id ?? '',
      allowedUserId: status.ilink_user_id ?? '',
      baseUrl: normalizedWechatBaseUrl(status.baseurl),
    });
    return { status: 'connected', sessionToken: null, credentials };
  }
  if (status.status === 'scaned_but_redirect' && status.redirect_host) {
    const nextToken = sealLoginPayload(cipher, {
      ...payload,
      pollingBaseUrl: normalizedWechatBaseUrl(status.redirect_host),
    });
    return { status: 'scanned', sessionToken: nextToken };
  }
  if (status.status === 'scaned') {
    return { status: 'scanned', sessionToken };
  }
  if (status.status === 'need_verifycode') {
    return { status: 'verification_required', sessionToken };
  }
  if (status.status === 'binded_redirect') {
    return { status: 'conflict', sessionToken: null };
  }
  if (status.status === 'verify_code_blocked') {
    return { status: 'blocked', sessionToken: null };
  }
  if (status.status === 'expired') {
    return { status: 'expired', sessionToken: null };
  }
  return { status: 'waiting', sessionToken };
}

function sealLoginPayload(
  cipher: CredentialCipher,
  payload: WechatLoginPayload,
): string {
  const encrypted = cipher.encrypt(JSON.stringify(payload), {
    userId: payload.userId,
    provider: LOGIN_PROVIDER,
  });
  return `${encrypted.keyVersion}.${encrypted.ciphertext.toString('base64url')}`;
}

function openLoginPayload(
  cipher: CredentialCipher,
  userId: string,
  token: string,
): WechatLoginPayload {
  if (token.length > 16_384) throw new Error('invalid_wechat_login_session');
  const separator = token.indexOf('.');
  if (separator <= 0) throw new Error('invalid_wechat_login_session');
  const keyVersion = token.slice(0, separator);
  const encoded = token.slice(separator + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      cipher.decrypt(
        { keyVersion, ciphertext: Buffer.from(encoded, 'base64url') },
        { userId, provider: LOGIN_PROVIDER },
      ),
    );
  } catch {
    throw new Error('invalid_wechat_login_session');
  }
  if (
    !isRecord(parsed) ||
    parsed.userId !== userId ||
    typeof parsed.qrcode !== 'string' ||
    !parsed.qrcode ||
    typeof parsed.pollingBaseUrl !== 'string' ||
    typeof parsed.expiresAt !== 'string'
  ) {
    throw new Error('invalid_wechat_login_session');
  }
  return {
    userId,
    qrcode: parsed.qrcode,
    pollingBaseUrl: normalizedWechatBaseUrl(parsed.pollingBaseUrl),
    expiresAt: parsed.expiresAt,
  };
}

function normalizedWechatBaseUrl(value?: string): string {
  const candidate = value
    ? /^https?:\/\//i.test(value)
      ? value
      : `https://${value}`
    : WECHAT_BASE_URL;
  const url = new URL(candidate);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !(
      hostname === 'weixin.qq.com' ||
      hostname.endsWith('.weixin.qq.com')
    ) ||
    url.username ||
    url.password
  ) {
    throw new Error('invalid_wechat_login_redirect');
  }
  return `${url.origin}/`;
}

async function wechatRequest<T>(
  url: URL,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`wechat_login_http_${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function loginHeaders(): Record<string, string> {
  return { ...statusHeaders(), 'Content-Type': 'application/json' };
}

function statusHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

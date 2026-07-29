import { createHash } from 'node:crypto';

export type WechatMessage = {
  seq?: number;
  message_id?: number;
  client_id?: string;
  from_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    voice_item?: { text?: string };
    file_item?: { file_name?: string };
  }>;
  context_token?: string;
};

export type WechatUpdates = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

export type WechatProtocolCredentials = {
  botToken: string;
  botId: string;
  allowedUserId: string;
  baseUrl: string;
};

export interface WechatProtocolClient {
  getUpdates(
    credentials: WechatProtocolCredentials,
    cursor: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WechatUpdates>;
  sendText(
    credentials: WechatProtocolCredentials,
    incoming: WechatMessage,
    text: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export type NormalizedWechatCapture = {
  externalId: string;
  type: 'text' | 'voice';
  content: string;
  createdAt: string;
};

const CHANNEL_VERSION = '2.4.6';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

export class IlinkWechatProtocolClient implements WechatProtocolClient {
  async getUpdates(
    credentials: WechatProtocolCredentials,
    cursor: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WechatUpdates> {
    return postJson<WechatUpdates>(
      credentials,
      'ilink/bot/getupdates',
      {
        get_updates_buf: cursor,
        base_info: baseInfo(),
      },
      Math.max(timeoutMs, 40_000),
      signal,
    );
  }

  async sendText(
    credentials: WechatProtocolCredentials,
    incoming: WechatMessage,
    text: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await postJson<{ ret?: number; errmsg?: string }>(
      credentials,
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: incoming.from_user_id,
          client_id: `remind-${createHash('sha256')
            .update(idempotencyKey)
            .digest('hex')
            .slice(0, 32)}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: incoming.context_token,
        },
        base_info: baseInfo(),
      },
      15_000,
      signal,
    );
    if (response.ret && response.ret !== 0) {
      throw new Error(`wechat_send_failed_${response.ret}`);
    }
  }
}

export function normalizeWechatMessage(
  message: WechatMessage,
  allowedUserId: string,
): NormalizedWechatCapture | null {
  if (
    message.message_type !== 1 ||
    !message.from_user_id ||
    message.from_user_id !== allowedUserId
  ) {
    return null;
  }
  const textParts: string[] = [];
  const voiceParts: string[] = [];
  for (const item of message.item_list ?? []) {
    const text = item.type === 1 ? item.text_item?.text?.trim() : '';
    if (text) textParts.push(text);
    const voice = item.type === 3 ? item.voice_item?.text?.trim() : '';
    if (voice) voiceParts.push(voice);
    if (item.type === 4 && item.file_item?.file_name) {
      textParts.push(`[文件] ${item.file_item.file_name}`);
    }
  }
  const content = [...textParts, ...voiceParts].join('\n').trim();
  if (!content) return null;
  const fallbackId = createHash('sha256')
    .update(
      [
        message.from_user_id,
        message.create_time_ms ?? '',
        message.seq ?? '',
        content,
      ].join(':'),
    )
    .digest('hex');
  const rawExternalId = String(
    message.message_id ?? message.client_id ?? fallbackId,
  );
  const externalId =
    rawExternalId.length <= 256
      ? rawExternalId
      : createHash('sha256').update(rawExternalId).digest('hex');
  const createdAt = safeCreatedAt(message.create_time_ms);
  return {
    externalId,
    type: voiceParts.length > 0 && textParts.length === 0 ? 'voice' : 'text',
    content: content.slice(0, 50_000),
    createdAt,
  };
}

export function validateWechatCredentials(
  value: WechatProtocolCredentials,
): WechatProtocolCredentials {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.baseUrl !== 'string' ||
    typeof value.botToken !== 'string' ||
    typeof value.botId !== 'string' ||
    typeof value.allowedUserId !== 'string'
  ) {
    throw new Error('invalid_wechat_credentials');
  }
  const baseUrl = new URL(value.baseUrl);
  const hostname = baseUrl.hostname.toLowerCase();
  if (
    baseUrl.protocol !== 'https:' ||
    !(
      hostname === 'weixin.qq.com' ||
      hostname.endsWith('.weixin.qq.com')
    ) ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error('invalid_wechat_base_url');
  }
  if (
    !validCredentialPart(value.botToken, 12, 4096) ||
    !validCredentialPart(value.botId, 1, 512) ||
    !validCredentialPart(value.allowedUserId, 1, 512)
  ) {
    throw new Error('invalid_wechat_credentials');
  }
  return {
    botToken: value.botToken.trim(),
    botId: value.botId.trim(),
    allowedUserId: value.allowedUserId.trim(),
    baseUrl: `${baseUrl.origin}/`,
  };
}

async function postJson<T>(
  credentials: WechatProtocolCredentials,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('wechat_request_timeout')),
    timeoutMs,
  );
  const abortParent = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abortParent, { once: true });
  try {
    const response = await fetch(new URL(path, credentials.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String(CLIENT_VERSION),
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(
          String(Math.floor(Math.random() * 0xffffffff)),
          'utf8',
        ).toString('base64'),
        Authorization: `Bearer ${credentials.botToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`wechat_http_${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abortParent);
  }
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: 'ReMind/0.1.0',
  };
}

function validCredentialPart(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= minimum &&
    trimmed.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(trimmed)
  );
}

function safeCreatedAt(value: number | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

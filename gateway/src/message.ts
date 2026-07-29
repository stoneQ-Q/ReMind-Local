import { createHash } from 'node:crypto';

import type { WeixinMessage } from './types.js';

export type NormalizedCapture = {
  externalId: string;
  type: 'text' | 'voice' | 'link';
  content: string;
  createdAt: string;
};

export function normalizeIncomingMessage(
  message: WeixinMessage,
  allowedUserId: string,
): NormalizedCapture | null {
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
  const createdAt = new Date(
    message.create_time_ms && Number.isFinite(message.create_time_ms)
      ? message.create_time_ms
      : Date.now(),
  ).toISOString();
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

  return {
    externalId: String(
      message.message_id ?? message.client_id ?? fallbackId,
    ),
    type: voiceParts.length && !textParts.length ? 'voice' : 'text',
    content,
    createdAt,
  };
}

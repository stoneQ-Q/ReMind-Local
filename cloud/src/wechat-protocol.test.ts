import { describe, expect, it } from 'vitest';

import {
  normalizeWechatMessage,
  validateWechatCredentials,
} from './wechat-protocol.js';

describe('WeChat iLink protocol boundary', () => {
  it('accepts only HTTPS WeChat hosts and strips paths', () => {
    expect(
      validateWechatCredentials({
        botToken: 'token-123456789',
        botId: 'bot-1',
        allowedUserId: 'user-1',
        baseUrl: 'https://ilinkai.weixin.qq.com/untrusted/path?query=1',
      }).baseUrl,
    ).toBe('https://ilinkai.weixin.qq.com/');

    expect(() =>
      validateWechatCredentials({
        botToken: 'token-123456789',
        botId: 'bot-1',
        allowedUserId: 'user-1',
        baseUrl: 'http://ilinkai.weixin.qq.com',
      }),
    ).toThrow('invalid_wechat_base_url');
    expect(() =>
      validateWechatCredentials({
        botToken: 'token-123456789',
        botId: 'bot-1',
        allowedUserId: 'user-1',
        baseUrl: 'https://weixin.qq.com.attacker.example',
      }),
    ).toThrow('invalid_wechat_base_url');
  });

  it('normalizes allowed text and voice while rejecting another sender', () => {
    expect(
      normalizeWechatMessage(
        {
          message_id: 42,
          message_type: 1,
          from_user_id: 'allowed',
          create_time_ms: 1_700_000_000_000,
          item_list: [{ type: 1, text_item: { text: '  记下来  ' } }],
        },
        'allowed',
      ),
    ).toMatchObject({
      externalId: '42',
      type: 'text',
      content: '记下来',
    });
    expect(
      normalizeWechatMessage(
        {
          client_id: 'voice-1',
          message_type: 1,
          from_user_id: 'allowed',
          item_list: [{ type: 3, voice_item: { text: '语音转写' } }],
        },
        'allowed',
      ),
    ).toMatchObject({ externalId: 'voice-1', type: 'voice' });
    expect(
      normalizeWechatMessage(
        {
          message_type: 1,
          from_user_id: 'someone-else',
          item_list: [{ type: 1, text_item: { text: '不要保存' } }],
        },
        'allowed',
      ),
    ).toBeNull();
  });

  it('bounds attacker-controlled external IDs and invalid timestamps', () => {
    const capture = normalizeWechatMessage(
      {
        client_id: 'x'.repeat(500),
        message_type: 1,
        from_user_id: 'allowed',
        create_time_ms: Number.MAX_VALUE,
        item_list: [{ type: 1, text_item: { text: '内容' } }],
      },
      'allowed',
    );

    expect(capture?.externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isNaN(Date.parse(capture?.createdAt ?? ''))).toBe(false);
  });
});

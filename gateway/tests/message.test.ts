import { describe, expect, it } from 'vitest';

import { normalizeIncomingMessage } from '../src/message.js';

describe('normalizeIncomingMessage', () => {
  it('normalizes an allowed text message', () => {
    expect(
      normalizeIncomingMessage(
        {
          message_id: 42,
          message_type: 1,
          from_user_id: 'stone@im.wechat',
          create_time_ms: 1_720_000_000_000,
          item_list: [{ type: 1, text_item: { text: '  记下旅行计划  ' } }],
        },
        'stone@im.wechat',
      ),
    ).toEqual({
      externalId: '42',
      type: 'text',
      content: '记下旅行计划',
      createdAt: '2024-07-03T09:46:40.000Z',
    });
  });

  it('rejects bot messages and unapproved senders', () => {
    expect(
      normalizeIncomingMessage(
        {
          message_type: 2,
          from_user_id: 'stone@im.wechat',
          item_list: [{ type: 1, text_item: { text: 'bot' } }],
        },
        'stone@im.wechat',
      ),
    ).toBeNull();
    expect(
      normalizeIncomingMessage(
        {
          message_type: 1,
          from_user_id: 'other@im.wechat',
          item_list: [{ type: 1, text_item: { text: 'other' } }],
        },
        'stone@im.wechat',
      ),
    ).toBeNull();
  });
});

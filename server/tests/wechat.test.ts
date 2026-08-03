import { describe, expect, it } from 'vitest';

import {
  messageContent,
  parseBindingCode,
  parseWechatMessage,
  textReplyXml,
  verifyWechatSignature,
} from '../src/wechat';

describe('WeChat callback helpers', () => {
  it('verifies the documented SHA-1 signature shape', async () => {
    expect(
      await verifyWechatSignature(
        'token',
        '1710000000',
        '42',
        'c7f92d3e03f2b1f58a290e8d92a3b7770c66d85b',
      ),
    ).toBe(false);

    const values = ['token', '1710000000', '42'].sort().join('');
    const bytes = new TextEncoder().encode(values);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    const signature = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    expect(
      await verifyWechatSignature('token', '1710000000', '42', signature),
    ).toBe(true);
  });

  it('parses a text message and binding command', () => {
    const message = parseWechatMessage(`<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[user_open_id]]></FromUserName>
      <CreateTime>1710000000</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[绑定 123456]]></Content>
      <MsgId>9001</MsgId>
    </xml>`);

    expect(message.fromUserName).toBe('user_open_id');
    expect(parseBindingCode(message.content)).toBe('123456');
    expect(messageContent(message)).toBe('绑定 123456');
  });

  it('normalizes a shared link into note content', () => {
    const message = parseWechatMessage(`<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[user_open_id]]></FromUserName>
      <CreateTime>1710000000</CreateTime>
      <MsgType><![CDATA[link]]></MsgType>
      <Title><![CDATA[值得保存的文章]]></Title>
      <Description><![CDATA[稍后阅读]]></Description>
      <Url><![CDATA[https://example.com/read]]></Url>
      <MsgId>9002</MsgId>
    </xml>`);

    expect(messageContent(message)).toBe(
      '值得保存的文章\n稍后阅读\nhttps://example.com/read',
    );
  });

  it('escapes nested CDATA endings in replies', () => {
    const message = parseWechatMessage(`<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[user_open_id]]></FromUserName>
      <CreateTime>1710000000</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[hello]]></Content>
      <MsgId>9003</MsgId>
    </xml>`);

    expect(textReplyXml(message, 'ok ]]> still safe')).toContain(
      'ok ]]]]><![CDATA[> still safe',
    );
  });
});

import { sha1Hex } from './crypto';
import type { WechatMessage } from './types';

export async function verifyWechatSignature(
  token: string,
  timestamp: string,
  nonce: string,
  signature: string,
): Promise<boolean> {
  if (!token || !timestamp || !nonce || !signature) return false;
  const expected = await sha1Hex([token, timestamp, nonce].sort().join(''));
  return constantTimeEqual(expected, signature.toLowerCase());
}

export function parseWechatMessage(xml: string): WechatMessage {
  return {
    toUserName: readXmlTag(xml, 'ToUserName'),
    fromUserName: readXmlTag(xml, 'FromUserName'),
    createTime: Number(readXmlTag(xml, 'CreateTime')) || 0,
    msgType: readXmlTag(xml, 'MsgType').toLowerCase(),
    msgId:
      readXmlTag(xml, 'MsgId') ||
      `${readXmlTag(xml, 'FromUserName')}:${readXmlTag(xml, 'CreateTime')}`,
    content: readXmlTag(xml, 'Content'),
    title: readXmlTag(xml, 'Title'),
    description: readXmlTag(xml, 'Description'),
    url: readXmlTag(xml, 'Url'),
  };
}

export function messageContent(message: WechatMessage): string | null {
  if (message.msgType === 'text') return message.content.trim();
  if (message.msgType === 'link') {
    return [message.title, message.description, message.url]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n');
  }
  return null;
}

export function textReplyXml(
  incoming: WechatMessage,
  content: string,
): string {
  return `<xml>
<ToUserName><![CDATA[${safeCdata(incoming.fromUserName)}]]></ToUserName>
<FromUserName><![CDATA[${safeCdata(incoming.toUserName)}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${safeCdata(content)}]]></Content>
</xml>`;
}

export function parseBindingCode(content: string): string | null {
  const match = content.trim().match(/^绑定\s*([0-9]{6})$/);
  return match?.[1] ?? null;
}

function readXmlTag(xml: string, tag: string): string {
  const expression = new RegExp(
    `<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`,
    'i',
  );
  const match = xml.match(expression);
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

function safeCdata(value: string): string {
  return value.replace(/]]>/g, ']]]]><![CDATA[>');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

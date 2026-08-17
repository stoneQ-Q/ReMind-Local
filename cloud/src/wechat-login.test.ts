import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalAesGcmCredentialCipher } from './credential-cipher.js';
import { checkWechatLogin, startWechatLogin } from './wechat-login.js';

const cipher = new LocalAesGcmCredentialCipher(
  'v1',
  new Map([['v1', Buffer.alloc(32, 7)]]),
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('self-service WeChat login', () => {
  it('returns a short-lived encrypted session and an in-app QR image', async () => {
    vi.setSystemTime(new Date('2026-08-17T08:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            qrcode: 'private-login-id',
            qrcode_img_content: 'https://weixin.qq.com/x/self-service-login',
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await startWechatLogin(cipher, 'user-1');

    expect(result.expiresAt).toBe('2026-08-17T08:10:00.000Z');
    expect(result.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.sessionToken).not.toContain('private-login-id');
  });

  it('keeps login sessions bound to the authenticated account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            qrcode: 'private-login-id',
            qrcode_img_content: 'https://weixin.qq.com/x/self-service-login',
          }),
          { status: 200 },
        ),
      ),
    );
    const started = await startWechatLogin(cipher, 'user-1');

    await expect(
      checkWechatLogin(cipher, 'user-2', started.sessionToken),
    ).rejects.toThrow('invalid_wechat_login_session');
  });

  it('returns validated credentials only after WeChat confirms', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            qrcode: 'private-login-id',
            qrcode_img_content: 'https://weixin.qq.com/x/self-service-login',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'secure-bot-token-value',
            ilink_bot_id: 'bot-1',
            ilink_user_id: 'user-wechat-1',
            baseurl: 'ilinkai.weixin.qq.com',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const started = await startWechatLogin(cipher, 'user-1');

    await expect(
      checkWechatLogin(cipher, 'user-1', started.sessionToken),
    ).resolves.toEqual({
      status: 'connected',
      sessionToken: null,
      credentials: {
        botToken: 'secure-bot-token-value',
        botId: 'bot-1',
        allowedUserId: 'user-wechat-1',
        baseUrl: 'https://ilinkai.weixin.qq.com/',
      },
    });
  });
});

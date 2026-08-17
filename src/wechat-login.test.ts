import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock('./cloud-api', () => ({
  requestCloud: vi.fn(),
  requestCloudJson: vi.fn(),
}));

import { requestCloudJson } from './cloud-api';
import {
  checkCloudWechatLogin,
  startCloudWechatLogin,
} from './wechat-sync';

afterEach(() => {
  vi.clearAllMocks();
});

describe('in-app WeChat login client', () => {
  it('starts a QR login without requesting a gateway binding code', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      sessionToken: 'v1.encrypted',
      qrImageDataUrl: 'data:image/png;base64,cXJjb2Rl',
      expiresAt: '2026-08-17T08:10:00.000Z',
    });

    await expect(startCloudWechatLogin()).resolves.toEqual({
      sessionToken: 'v1.encrypted',
      qrImageDataUrl: 'data:image/png;base64,cXJjb2Rl',
      expiresAt: '2026-08-17T08:10:00.000Z',
    });
    expect(requestCloudJson).toHaveBeenCalledWith('wechat/login', {
      method: 'POST',
    });
  });

  it('checks confirmation with a bounded long-poll timeout', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      status: 'connected',
      sessionToken: null,
    });

    await expect(
      checkCloudWechatLogin('v1.encrypted', '123456'),
    ).resolves.toEqual({ status: 'connected', sessionToken: null });
    expect(requestCloudJson).toHaveBeenCalledWith(
      'wechat/login/check',
      {
        method: 'POST',
        body: JSON.stringify({
          sessionToken: 'v1.encrypted',
          verificationCode: '123456',
        }),
      },
      45_000,
    );
  });

  it('rejects malformed QR responses', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      sessionToken: 'plaintext-secret',
      qrImageDataUrl: 'https://example.com/qr.png',
      expiresAt: '2026-08-17T08:10:00.000Z',
    });

    await expect(startCloudWechatLogin()).rejects.toThrow(
      'invalid_wechat_login_response',
    );
  });
});

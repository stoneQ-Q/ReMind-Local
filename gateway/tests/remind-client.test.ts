import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadLinkSnapshot } from '../src/remind-client.js';

describe('uploadLinkSnapshot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never uploads the transient source video URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await uploadLinkSnapshot(
      'http://127.0.0.1:8787',
      {
        connectorId: 'connector-id',
        connectorSecret: 'connector-secret',
        kind: 'weixin-ilink',
      },
      'message-id',
      {
        title: '视频标题',
        site: 'xiaohongshu.com',
        text: '作者文案与视频转写'.repeat(10),
        images: [],
        platform: 'xiaohongshu',
        mediaType: 'video',
        durationSeconds: 382,
        transientVideoUrl: 'https://sns-video-v3.xhscdn.com/private-source',
      },
    );

    const body = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(body.mediaType).toBe('video');
    expect(body.durationSeconds).toBe(382);
    expect(body).not.toHaveProperty('transientVideoUrl');
    expect(JSON.stringify(body)).not.toContain('private-source');
  });
});

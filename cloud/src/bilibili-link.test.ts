import { describe, expect, it, vi } from 'vitest';

import {
  extractBilibiliVideoId,
  fetchBilibiliSnapshot,
  SecureBilibiliAudioFetcher,
  selectBilibiliAudioUrl,
} from './bilibili-link.js';

const bvid = 'BV1xkb468EP2';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Bilibili link ingestion', () => {
  it('recognizes video ids in canonical URLs and embedded short-link pages', () => {
    expect(
      extractBilibiliVideoId(`https://www.bilibili.com/video/${bvid}`),
    ).toBe(bvid);
    expect(
      extractBilibiliVideoId('https://b23.tv/example', `{"bvid":"${bvid}"}`),
    ).toBe(bvid);
  });

  it('uses Bilibili subtitles before requesting an audio stream', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/x/web-interface/view')) {
        return json({
          code: 0,
          data: {
            cid: 123,
            duration: 95,
            title: '字幕测试视频',
            desc: '一段用于验证字幕优先路径的视频简介。',
            owner: { name: '测试 UP 主' },
          },
        });
      }
      if (url.includes('/x/player/v2')) {
        return json({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                {
                  lan: 'zh-CN',
                  lan_doc: '中文（自动生成）',
                  subtitle_url: '//aisubtitle.hdslb.com/test.json',
                },
              ],
            },
          },
        });
      }
      if (url === 'https://aisubtitle.hdslb.com/test.json') {
        return json({
          body: [
            { from: 0, to: 2.5, content: '第一句字幕' },
            { from: 2.5, to: 5, content: '第二句字幕' },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const snapshot = await fetchBilibiliSnapshot(
      new URL(`https://www.bilibili.com/video/${bvid}`),
      '',
      new AbortController().signal,
      fetcher,
    );

    expect(snapshot).toMatchObject({
      url: `https://www.bilibili.com/video/${bvid}`,
      title: '字幕测试视频',
      platform: 'bilibili',
      mediaType: 'video',
      durationSeconds: 95,
      transientAudioUrl: undefined,
    });
    expect(snapshot?.embeddedTranscript?.transcript).toBe(
      '第一句字幕\n第二句字幕',
    );
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/playurl'))).toBe(
      false,
    );
  });

  it('falls back to a trusted Bilibili audio CDN when subtitles are absent', async () => {
    const trustedAudio =
      'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/audio.m4s?deadline=1#drop';
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/x/web-interface/view')) {
        return json({
          code: 0,
          data: {
            cid: 456,
            duration: 315,
            title: '无字幕测试视频',
            desc: '没有字幕时应返回临时音轨，供私有 Whisper 下载转写。',
            owner: { name: '测试 UP 主' },
          },
        });
      }
      if (url.includes('/x/player/v2')) {
        return json({ code: 0, data: { subtitle: { subtitles: [] } } });
      }
      if (url.includes('/x/player/playurl')) {
        return json({
          code: 0,
          data: { dash: { audio: [{ bandwidth: 80_000, baseUrl: trustedAudio }] } },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const snapshot = await fetchBilibiliSnapshot(
      new URL(`https://www.bilibili.com/video/${bvid}`),
      '',
      new AbortController().signal,
      fetcher,
    );

    expect(snapshot?.embeddedTranscript).toBeUndefined();
    expect(snapshot?.transientAudioUrl).toBe(
      'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/audio.m4s?deadline=1',
    );
  });

  it('uses the player pagelist when the richer view endpoint is blocked', async () => {
    const trustedAudio =
      'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/audio.m4s?deadline=1';
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/x/web-interface/view')) {
        return new Response('blocked', { status: 412 });
      }
      if (url.includes('/x/player/pagelist')) {
        return json({
          code: 0,
          data: [{ cid: 789, duration: 2088, part: '云端回退标题' }],
        });
      }
      if (url.includes('/x/player/v2')) {
        return json({ code: 0, data: { subtitle: { subtitles: [] } } });
      }
      if (url.includes('/x/player/playurl')) {
        return json({
          code: 0,
          data: { dash: { audio: [{ bandwidth: 80_000, baseUrl: trustedAudio }] } },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const snapshot = await fetchBilibiliSnapshot(
      new URL(`https://www.bilibili.com/video/${bvid}`),
      '',
      new AbortController().signal,
      fetcher,
    );

    expect(snapshot).toMatchObject({
      title: '云端回退标题',
      durationSeconds: 2088,
      transientAudioUrl:
        'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/audio.m4s?deadline=1',
    });
  });

  it('rejects media URLs outside Bilibili-owned CDNs', async () => {
    expect(() =>
      selectBilibiliAudioUrl({
        code: 0,
        data: {
          dash: {
            audio: [{ bandwidth: 1, baseUrl: 'https://attacker.example/audio.m4s' }],
          },
        },
      }),
    ).not.toThrow();
    expect(
      selectBilibiliAudioUrl({
        code: 0,
        data: {
          dash: {
            audio: [{ bandwidth: 1, baseUrl: 'https://attacker.example/audio.m4s' }],
          },
        },
      }),
    ).toBeNull();
    const fetcher = new SecureBilibiliAudioFetcher(vi.fn<typeof fetch>());
    await expect(
      fetcher.fetch(
        'https://attacker.example/audio.m4s',
        new AbortController().signal,
      ),
    ).rejects.toThrow('link_bilibili_audio_url_invalid');
  });

  it('prefers Bilibili’s Akamai backup when it is available', () => {
    const payload = {
      code: 0,
      data: {
        dash: {
          audio: [
            {
              bandwidth: 80_000,
              baseUrl: 'https://upos-sz-mirrorcosov.bilivideo.com/audio.m4s',
              backupUrl: [
                'https://upos-hz-mirrorakam.akamaized.net/audio.m4s',
              ],
            },
          ],
        },
      },
    };

    expect(selectBilibiliAudioUrl(payload)).toBe(
      'https://upos-hz-mirrorakam.akamaized.net/audio.m4s',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { parseLinkInput } from './link-input.js';
import {
  extractLinkSnapshot,
  SecureXiaoyuzhouAudioFetcher,
  SecureXiaohongshuVideoFetcher,
  validatePublicLinkUrl,
} from './link-page.js';

describe('link processing boundary', () => {
  it('extracts the first URL and preserves the user context', () => {
    expect(
      parseLinkInput(
        '保存理由：下周做内容规划 https://example.com/article，另见 https://example.org',
      ),
    ).toEqual({
      url: 'https://example.com/article',
      userContext: '下周做内容规划 ，另见 https://example.org',
      urlCount: 2,
    });
  });

  it('rejects private, credentialed, and nonstandard-port URLs', () => {
    for (const value of [
      'http://127.0.0.1/a',
      'http://10.0.0.1/a',
      'http://[::1]/a',
      'https://metadata.google.internal/latest',
      'https://user:password@example.com',
      'https://example.com:8443/a',
      'file:///etc/passwd',
    ]) {
      expect(() => validatePublicLinkUrl(value)).toThrow();
    }
    expect(validatePublicLinkUrl('https://example.com/a#private-fragment')).toBe(
      'https://example.com/a',
    );
  });

  it('extracts a bounded ordinary web snapshot without scripts', () => {
    const snapshot = extractLinkSnapshot(
      'https://example.com/article',
      `<html><head>
        <title>示例文章</title>
        <meta name="description" content="一段文章说明">
        <script>不应进入正文</script>
       </head><body><h1>示例文章</h1><p>${'正文内容'.repeat(30)}</p></body></html>`,
    );

    expect(snapshot).toMatchObject({
      title: '示例文章',
      description: '一段文章说明',
      site: 'example.com',
      platform: 'web',
      mediaType: 'web',
    });
    expect(snapshot.text).not.toContain('不应进入正文');
  });

  it('extracts a public Xiaoyuzhou episode while keeping its CDN URL transient', () => {
    const nextData = JSON.stringify({
      props: {
        pageProps: {
          episode: {
            title: '如何把播客变成可回看的个人知识',
            description: '本期讨论记录、转写和回顾之间的关系。',
            duration: 3_661,
            payType: 'FREE',
            isPrivateMedia: false,
            enclosure: {
              url: 'https://media.xyzcdn.net/podcast/episode.m4a?token=public#ignored',
            },
            podcast: { title: '回声实验室', author: '小宇宙主播' },
          },
        },
      },
    });
    const snapshot = extractLinkSnapshot(
      'https://www.xiaoyuzhoufm.com/episode/69ac329bc8cdeb38c25497d4',
      `<script id="__NEXT_DATA__" type="application/json">${nextData}</script>`,
    );

    expect(snapshot).toMatchObject({
      title: '如何把播客变成可回看的个人知识',
      site: 'xiaoyuzhoufm.com',
      platform: 'xiaoyuzhou',
      mediaType: 'audio',
      durationSeconds: 3_661,
      transientAudioUrl:
        'https://media.xyzcdn.net/podcast/episode.m4a?token=public',
    });
    expect(snapshot.text).toContain('播客：回声实验室');
    expect(snapshot.text).toContain('主播：小宇宙主播');
  });

  it('rejects paid Xiaoyuzhou episodes and untrusted audio hosts', () => {
    const page = (episode: Record<string, unknown>) =>
      `<script id="__NEXT_DATA__">${JSON.stringify({
        props: { pageProps: { episode } },
      })}</script>`;
    const url =
      'https://www.xiaoyuzhoufm.com/episode/69ac329bc8cdeb38c25497d4';
    expect(() =>
      extractLinkSnapshot(
        url,
        page({
          title: '付费单集',
          duration: 600,
          payType: 'PAID',
          enclosure: { url: 'https://media.xyzcdn.net/private.m4a' },
        }),
      ),
    ).toThrow('link_xiaoyuzhou_restricted');
    expect(() =>
      extractLinkSnapshot(
        url,
        page({
          title: '伪造单集',
          description: '这段介绍足够长，但媒体地址不属于可信的小宇宙 CDN。',
          duration: 600,
          payType: 'FREE',
          enclosure: { url: 'https://attacker.example/audio.m4a' },
        }),
      ),
    ).toThrow('link_xiaoyuzhou_audio_unavailable');
  });

  it('extracts XHS images only from its HTTPS CDN', () => {
    const snapshot = extractLinkSnapshot(
      'https://www.xiaohongshu.com/explore/note-1',
      `<html><head>
        <meta property="og:title" content="周末散步 - 小红书">
        <meta property="og:description" content="${'这是一段小红书图文正文'.repeat(5)}">
        <meta property="og:image" content="http://sns-img.xhscdn.com/a.jpg">
        <meta property="og:image" content="https://attacker.example/a.jpg">
       </head></html>`,
    );

    expect(snapshot).toMatchObject({
      title: '周末散步',
      platform: 'xiaohongshu',
      mediaType: 'image',
      images: ['https://sns-img.xhscdn.com/a.jpg'],
    });
  });

  it('recognizes XHS video without making its temporary URL persistent data', () => {
    const snapshot = extractLinkSnapshot(
      'https://www.xiaohongshu.com/explore/note-2',
      `<html><head>
        <meta property="og:title" content="视频笔记 - 小红书">
        <meta property="og:description" content="${'这是一段小红书视频正文'.repeat(5)}">
       </head><body>
        {"duration":90000,"masterUrl":"https:\\u002F\\u002Fsns-video.xhscdn.com\\u002Fvideo.mp4"}
       </body></html>`,
    );

    expect(snapshot).toMatchObject({
      platform: 'xiaohongshu',
      mediaType: 'video',
      durationSeconds: 90,
      transientVideoUrl: 'https://sns-video.xhscdn.com/video.mp4',
    });
  });

  it('extracts embedded video data from an XHS short-link page', () => {
    const snapshot = extractLinkSnapshot(
      'http://xhslink.cn/o/example',
      `<html><head><title>小红书</title></head><body><script>
        window.__INITIAL_STATE__={"noteData":{"routeQuery":{},"data":{"noteData":{
          "type":"video",
          "title":"Loop Engineering 视频",
          "desc":"这是一段足够长的小红书视频说明，用于验证短链接页面内嵌数据能够被安全提取。",
          "video":{"media":{"stream":{"h264":[{
            "videoDuration":456200,
            "masterUrl":"http:\\u002F\\u002Fsns-video-v6.xhscdn.com\\u002Fstream.mp4?sign=test"
          }]}}}
        }}}};
      </script></body></html>`,
    );

    expect(snapshot).toMatchObject({
      title: 'Loop Engineering 视频',
      text: '这是一段足够长的小红书视频说明，用于验证短链接页面内嵌数据能够被安全提取。',
      site: 'xiaohongshu.com',
      platform: 'xiaohongshu',
      mediaType: 'video',
      durationSeconds: 456,
      transientVideoUrl:
        'https://sns-video-v6.xhscdn.com/stream.mp4?sign=test',
    });
  });

  it('keeps video downloads inside the HTTPS XHS CDN boundary', async () => {
    const fetcher = new SecureXiaohongshuVideoFetcher();
    const signal = new AbortController().signal;

    await expect(
      fetcher.fetch('https://attacker.example/video.mp4', signal),
    ).rejects.toThrow('link_video_url_invalid');
    await expect(
      fetcher.fetch('http://sns-video.xhscdn.com/video.mp4', signal),
    ).rejects.toThrow('link_video_url_invalid');
    await expect(
      fetcher.fetch('https://127.0.0.1/video.mp4', signal),
    ).rejects.toThrow('link_video_url_invalid');
  });

  it('keeps audio downloads inside the HTTPS Xiaoyuzhou CDN boundary', async () => {
    const fetcher = new SecureXiaoyuzhouAudioFetcher();
    const signal = new AbortController().signal;

    await expect(
      fetcher.fetch('https://attacker.example/audio.m4a', signal),
    ).rejects.toThrow('link_audio_url_invalid');
    await expect(
      fetcher.fetch('http://media.xyzcdn.net/audio.m4a', signal),
    ).rejects.toThrow('link_audio_url_invalid');
  });
});

import { describe, expect, it } from 'vitest';

import { extractLinkSnapshot } from '../src/link-reader.js';

describe('extractLinkSnapshot', () => {
  it('extracts Xiaohongshu caption and image gallery from metadata', () => {
    const snapshot = extractLinkSnapshot(
      'https://www.xiaohongshu.com/discovery/item/note-id?xsec_token=token',
      `
        <html>
          <head>
            <title>我们做了一款骰子拼贴诗礼盒 - 小红书</title>
            <meta name="description" content="3 亿人的生活经验，都在小红书">
            <meta property="og:title" content="我们做了一款骰子拼贴诗礼盒 - 小红书">
            <meta property="og:description" content="一言「无尽诗」诗歌骰子礼盒，9颗骰子，54个精选词语。">
            <meta property="og:image" content="//sns-webpic-qc.xhscdn.com/one.jpg">
            <meta property="og:image" content="http://sns-webpic-qc.xhscdn.com/two.jpg">
          </head>
        </html>
      `,
    );

    expect(snapshot).toEqual({
      title: '我们做了一款骰子拼贴诗礼盒',
      site: 'xiaohongshu.com',
      text: '一言「无尽诗」诗歌骰子礼盒，9颗骰子，54个精选词语。',
      images: [
        'https://sns-webpic-qc.xhscdn.com/one.jpg',
        'https://sns-webpic-qc.xhscdn.com/two.jpg',
      ],
      platform: 'xiaohongshu',
      mediaType: 'image',
      durationSeconds: null,
    });
  });

  it('detects Xiaohongshu video without retaining its cover as note media', () => {
    const snapshot = extractLinkSnapshot(
      'https://www.xiaohongshu.com/discovery/item/video-note?type=video',
      `
        <meta property="og:title" content="如何做内容 - 小红书">
        <meta property="og:description" content="分享我做内容的方法和实际经验，包括内容定位、互动方式与持续发布节奏。">
        <meta property="og:image" content="//sns-webpic-qc.xhscdn.com/cover.jpg">
        <script>
          window.__INITIAL_STATE__ = {
            "duration": 381433,
            "masterUrl": "http:\\u002F\\u002Fsns-video-v3.xhscdn.com\\u002Fstream\\u002Fvideo"
          };
        </script>
      `,
    );

    expect(snapshot.mediaType).toBe('video');
    expect(snapshot.durationSeconds).toBe(381);
    expect(snapshot.images).toEqual([]);
    expect(snapshot.transientVideoUrl).toBe(
      'https://sns-video-v3.xhscdn.com/stream/video',
    );
  });

  it('rejects Xiaohongshu security pages', () => {
    expect(() =>
      extractLinkSnapshot(
        'https://www.xiaohongshu.com/404/sec_blocked',
        '<title>小红书</title>',
      ),
    ).toThrow('安全验证');
  });

  it('keeps ordinary readable web pages compatible', () => {
    const snapshot = extractLinkSnapshot(
      'https://example.com/post',
      `<title>Example</title><main>${'正文内容'.repeat(30)}</main>`,
    );
    expect(snapshot.platform).toBe('web');
    expect(snapshot.mediaType).toBe('web');
    expect(snapshot.images).toEqual([]);
    expect(snapshot.text.length).toBeGreaterThan(80);
  });
});

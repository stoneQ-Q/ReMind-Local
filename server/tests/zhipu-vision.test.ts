import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeImagesWithZhipu,
  ZHIPU_VISION_MODEL,
} from '../src/zhipu-vision';

describe('analyzeImagesWithZhipu', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends ordered images and asks for source-labelled observations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content:
                '### 图片 1\n\n蓝色半透明骰子。\n\n### 图片 2\n\n礼盒包装。',
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeImagesWithZhipu('secret', {
      title: '无尽诗',
      caption: '诗歌骰子礼盒',
      images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
    });

    expect(result.text).toContain('### 图片 1');
    expect(result.model).toBe(ZHIPU_VISION_MODEL);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{
        content: Array<{
          type: string;
          image_url?: { url: string };
          text?: string;
        }>;
      }>;
    };
    expect(body.model).toBe(ZHIPU_VISION_MODEL);
    expect(
      body.messages[0].content
        .filter((item) => item.type === 'image_url')
        .map((item) => item.image_url?.url),
    ).toEqual([
      'https://img.example/1.jpg',
      'https://img.example/2.jpg',
    ]);
    expect(body.messages[0].content.at(-1)?.text).toContain('不要猜');
    expect(body.messages[0].content.at(-1)?.text).toContain('无新增信息');
    expect(body.messages[0].content.at(-1)?.text).toContain('纯装饰性');
  });

  it('fails closed on an empty model response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(Response.json({ choices: [] })),
      ),
    );
    await expect(
      analyzeImagesWithZhipu('secret', {
        title: '无尽诗',
        caption: '诗歌骰子礼盒',
        images: ['https://img.example/1.jpg'],
      }),
    ).rejects.toThrow('empty visual analysis');
  });

  it('retries temporary capacity errors', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: '1305', message: '模型访问量过大' } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content:
                  '### 图片 1\n\n桌面上摆放着一组透明诗歌骰子和浅色礼盒包装。',
              },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = analyzeImagesWithZhipu('secret', {
      title: '无尽诗',
      caption: '诗歌骰子礼盒',
      images: ['https://img.example/1.jpg'],
    });
    const expectation = expect(resultPromise).resolves.toMatchObject({
      text: expect.stringContaining('透明诗歌骰子'),
      model: ZHIPU_VISION_MODEL,
    });
    await vi.runAllTimersAsync();

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

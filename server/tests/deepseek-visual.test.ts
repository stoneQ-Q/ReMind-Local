import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEvidenceCandidates,
  organizeLinkWithDeepSeek,
} from '../src/deepseek';

describe('organizeLinkWithDeepSeek visual context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps visual observations separate and asks for a concise natural note', async () => {
    const pageText =
      '一言无尽诗礼盒包含九颗骰子和五十四个精选词语，可以组合出许多短诗。';
    const evidenceId = buildEvidenceCandidates(pageText)[0].id;
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                drafts: [
                  {
                    title: '无尽诗骰子礼盒',
                    summary: '用骰子组合短诗。',
                    content:
                      '## 内容概括\n\n诗歌骰子礼盒。\n\n## 值得留下的内容\n\n- 九颗骰子组合诗句〔证据 E1、E1〕\n\n## 画面补充\n\n- 骰面使用可组合的词语〔图片 1〕\n\n## 与我的关注点\n\n适合作为诗歌产品设计案例。',
                    tags: ['诗歌', '文创'],
                    sourceIds: ['source-1'],
                    citations: [{ sourceId: 'source-1', evidenceId }],
                  },
                ],
                ignoredSourceIds: [],
              }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await organizeLinkWithDeepSeek('secret', {
      sourceId: 'source-1',
      url: 'https://www.xiaohongshu.com/discovery/item/note',
      userContext: '关注诗歌产品设计',
      page: {
        title: '无尽诗',
        description: '',
        site: 'xiaohongshu.com',
        text: pageText,
        images: ['https://sns-webpic-qc.xhscdn.com/1.jpg'],
        visualText: '### 图片 1\n\n蓝色半透明骰子与透明礼盒。',
        visualModel: 'glm-4.6v',
        mediaType: 'image',
        durationSeconds: null,
      },
    });

    expect(result.drafts[0].citations[0].quote).toBe(pageText);
    expect(result.drafts[0].content).toContain('〔证据 1、1〕');
    expect(result.drafts[0].content).not.toContain('证据 E1');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemPrompt = requestBody.messages.find(
      (message) => message.role === 'system',
    )!.content;
    expect(systemPrompt).toContain('## 值得留下的内容');
    expect(systemPrompt).toContain('## 画面补充');
    expect(systemPrompt).toContain('最多 3 条');
    expect(systemPrompt).toContain('作者文案和画面信息如果重复');
    expect(systemPrompt).not.toContain('## 图片观察');

    const userPayload = JSON.parse(
      requestBody.messages.find((message) => message.role === 'user')!.content,
    ) as {
      page: {
        imageCount: number;
        visualAnalysis: { model: string; content: string };
      };
      evidenceCandidates: Array<{ text: string }>;
    };
    expect(userPayload.page.imageCount).toBe(1);
    expect(userPayload.page.visualAnalysis.model).toBe('glm-4.6v');
    expect(userPayload.evidenceCandidates[0].text).toBe(pageText);
    expect(userPayload.evidenceCandidates[0].text).not.toContain('蓝色');
  });
});

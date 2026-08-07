import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEvidenceCandidates,
  DeepSeekHttpError,
  organizeWithDeepSeek,
  validateOrganizePayload,
  validateThemeMergePayload,
  type OrganizeSource,
} from '../src/deepseek';

afterEach(() => vi.restoreAllMocks());

const sources: OrganizeSource[] = [
  { id: 'a', content: '做每日整理', createdAt: '2026-07-26T10:00:00Z' },
  { id: 'b', content: '测试', createdAt: '2026-07-26T11:00:00Z' },
];

describe('validateOrganizePayload', () => {
  it('does not retry an invalid DeepSeek credential', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"error":{"message":"invalid key"}}', { status: 401 }),
      );

    await expect(organizeWithDeepSeek('invalid-key', sources)).rejects.toEqual(
      expect.objectContaining<Partial<DeepSeekHttpError>>({
        name: 'DeepSeekHttpError',
        status: 401,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps valid source citations and derives ignored sources', () => {
    expect(
      validateOrganizePayload(
        {
          drafts: [
            {
              title: '每日整理',
              summary: '把碎片变成笔记',
              content: '## 核心内容\n\n整理今天的记录。',
              tags: ['#ReMind'],
              sourceIds: ['a', 'unknown'],
            },
          ],
          ignoredSourceIds: ['b'],
        },
        sources,
      ),
    ).toEqual({
      drafts: [
        {
          id: 'draft-1',
          title: '每日整理',
          summary: '把碎片变成笔记',
          content: '## 核心内容\n\n整理今天的记录。',
          tags: ['ReMind'],
          sourceIds: ['a'],
          citations: [],
        },
      ],
      ignoredSourceIds: ['b'],
    });
  });

  it('keeps only verbatim link evidence and resolves source offsets', () => {
    const pageText = '第一段介绍。\n\n第二段说明持续生长的主题笔记，而不是摘要卡片。';
    const evidence = buildEvidenceCandidates(pageText);
    const result = validateOrganizePayload(
      {
        drafts: [
          {
            title: '持续生长的笔记',
            summary: '来源可追溯',
            content: '## 关键观点\n\n- 维护主题笔记〔证据 1〕',
            tags: ['笔记'],
            sourceIds: ['a'],
            citations: [
              {
                sourceId: 'a',
                evidenceId: evidence[0].id,
              },
            ],
          },
        ],
      },
      [sources[0]],
      new Map([['a', pageText]]),
      new Map([['a', new Map(evidence.map((item) => [item.id, item]))]]),
    );

    expect(result.drafts[0].citations).toEqual([
      {
        sourceId: 'a',
        quote: pageText,
        startOffset: 0,
        endOffset: pageText.length,
      },
    ]);
  });

  it('rejects link evidence that was not copied from the page', () => {
    expect(() =>
      validateOrganizePayload(
        {
          drafts: [
            {
              title: '无效证据',
              summary: '',
              content: '内容',
              tags: [],
              sourceIds: ['a'],
              citations: [{ sourceId: 'a', quote: '模型自己编造的句子' }],
            },
          ],
        },
        [sources[0]],
        new Map([['a', '真实网页正文']]),
      ),
    ).toThrow('Citation does not match source text');
  });

  it('rejects drafts without valid source citations', () => {
    expect(() =>
      validateOrganizePayload(
        {
          drafts: [
            {
              title: '无来源',
              summary: '',
              content: '内容',
              tags: [],
              sourceIds: ['unknown'],
            },
          ],
        },
        sources,
      ),
    ).toThrow('Draft is missing required fields');
  });
});

describe('validateThemeMergePayload', () => {
  const themes = [
    {
      id: 'theme-1',
      title: '拉美文学阅读',
      summary: '持续整理拉美文学作品',
      content: '## 已读作品',
      overview: '## 当前理解\n\n拉美文学作品与阅读线索。',
    },
  ];

  it('keeps a patch for an existing theme and preserves its real title', () => {
    expect(
      validateThemeMergePayload(
        {
          themeId: 'theme-1',
          themeTitle: '模型擅自改名',
          rationale: '同属拉美文学阅读主题。',
          patch: '## 推荐书目\n\n- 《百年孤独》',
          overview: '## 当前理解\n\n从《百年孤独》理解魔幻现实主义。',
          conflicts: [],
          candidateScores: [
            {
              themeId: 'theme-1',
              subjectScore: 92,
              purposeScore: 82,
              contributionScore: 86,
              reason: '单本作品解读可以补充拉美文学阅读主题。',
            },
          ],
        },
        themes,
      ),
    ).toEqual({
      themeId: 'theme-1',
      themeTitle: '拉美文学阅读',
      rationale: '单本作品解读可以补充拉美文学阅读主题。',
      patch: '## 推荐书目\n\n- 《百年孤独》',
      overview: '## 当前理解\n\n从《百年孤独》理解魔幻现实主义。',
      conflicts: [],
    });
  });

  it('recalls a high-scoring existing theme even if the model asks to create', () => {
    expect(
      validateThemeMergePayload(
        {
          themeId: null,
          themeTitle: '百年孤独解读',
          rationale: '建议新建。',
          patch: '## 《百年孤独》\n\n作品解读。',
          overview: '## 当前理解\n\n《百年孤独》是重要阅读入口。',
          conflicts: [],
          candidateScores: [
            {
              themeId: 'theme-1',
              subjectScore: 90,
              purposeScore: 75,
              contributionScore: 80,
              reason: '这是拉美文学阅读主题中的单本作品补充。',
            },
          ],
        },
        themes,
      ),
    ).toMatchObject({
      themeId: 'theme-1',
      themeTitle: '拉美文学阅读',
      rationale: '这是拉美文学阅读主题中的单本作品补充。',
    });
  });

  it('creates a new theme when every existing theme scores below threshold', () => {
    expect(
      validateThemeMergePayload(
        {
          themeId: null,
          themeTitle: '力量训练方法',
          rationale: '现有文学主题无法容纳健身内容。',
          patch: '## 训练安排\n\n每周三次。',
          overview: '## 当前安排\n\n每周进行三次力量训练。',
          conflicts: [],
          candidateScores: [
            {
              themeId: 'theme-1',
              subjectScore: 3,
              purposeScore: 8,
              contributionScore: 5,
              reason: '研究对象和用途都不同。',
            },
          ],
        },
        themes,
      ),
    ).toMatchObject({
      themeId: null,
      themeTitle: '力量训练方法',
    });
  });

  it('does not let a generic reading-method theme absorb a literature topic', () => {
    expect(
      validateThemeMergePayload(
        {
          themeId: 'deep-reading',
          themeTitle: '拉美文学经典',
          rationale: '都和阅读有关。',
          patch: '## 拉美文学书目\n\n- 《百年孤独》',
          overview: '## 入门书目\n\n从《百年孤独》开始。',
          conflicts: [],
          candidateScores: [
            {
              themeId: 'deep-reading',
              subjectScore: 28,
              purposeScore: 68,
              contributionScore: 72,
              reason: '阅读行为相关，但主要研究对象不同。',
            },
          ],
        },
        [
          {
            id: 'deep-reading',
            title: '深度阅读方法',
            summary: '如何精读和理解复杂文本',
            content: '## 阅读方法',
            overview: '## 当前理解\n\n整理复杂文本的阅读方法。',
          },
        ],
      ),
    ).toMatchObject({
      themeId: null,
      themeTitle: '拉美文学经典',
    });
  });

  it('rejects a theme id that was not offered to the model', () => {
    expect(() =>
      validateThemeMergePayload(
        {
          themeId: 'unknown',
          themeTitle: '未知主题',
          rationale: '不应通过。',
          patch: '内容',
          overview: '## 当前理解\n\n未知内容。',
          conflicts: [],
        },
        themes,
      ),
    ).toThrow('Theme merge selected an invalid theme');
  });

  it('requires a complete updated overview for new suggestions', () => {
    expect(() =>
      validateThemeMergePayload(
        {
          themeId: 'theme-1',
          themeTitle: '拉美文学阅读',
          rationale: '补充已有主题。',
          patch: '## 新增理解\n\n作品分析。',
          conflicts: [],
          candidateScores: [
            {
              themeId: 'theme-1',
              subjectScore: 90,
              purposeScore: 80,
              contributionScore: 75,
              reason: '研究对象一致。',
            },
          ],
        },
        themes,
      ),
    ).toThrow('Expected string');
  });
});

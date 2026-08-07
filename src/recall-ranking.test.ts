import { describe, expect, it } from 'vitest';

import { compareNotesForRecall } from './database';
import type { Note } from './types';

function note(overrides: Partial<Note>): Note {
  return {
    id: overrides.id ?? 'note',
    title: overrides.title ?? '标题',
    content: overrides.content ?? '',
    summary: overrides.summary ?? null,
    status: 'ready',
    source: 'ai',
    recordType: 'source',
    contentKind: 'text',
    sourceUrl: null,
    userContext: null,
    sourcePageTitle: null,
    sourcePageSite: null,
    sourcePageText: null,
    tags: overrides.tags ?? [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('recall relevance ranking', () => {
  it('does not connect unrelated notes through generic user wording', () => {
    const recent = note({
      id: 'growth',
      title: '一年 Twitter 涨粉七万的内容方法',
      summary: '从用户反馈中调整内容方法。',
      tags: ['内容', 'AI'],
    });
    const old = note({
      id: 'novel',
      title: '《百年孤独》七代人的命运启示',
      summary: '人物命运和人生选择。',
      tags: ['文学', '阅读'],
    });

    expect(compareNotesForRecall(recent, old)).toBeNull();
  });

  it('keeps a specific shared topic as a valid relation', () => {
    const first = note({
      title: '循环工程的验证与停止条件',
      summary: '如何给循环加闸门。',
    });
    const second = note({
      title: '循环工程的 token 成本',
      summary: '自动循环的成本边界。',
    });

    expect(compareNotesForRecall(first, second)).toMatchObject({
      relation: 'shared-keywords',
    });
  });

  it('requires a specific tag instead of a generic AI tag', () => {
    const first = note({ tags: ['AI', 'Loop Engineering'] });
    const second = note({ tags: ['AI', 'Loop Engineering'] });

    expect(compareNotesForRecall(first, second)).toMatchObject({
      relation: 'shared-tags',
      reason: '都涉及「loop engineering」',
    });
  });
});

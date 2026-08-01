import { describe, expect, it, vi } from 'vitest';

vi.mock('./wechat-sync', () => ({ requestAuthenticatedDeviceApi: vi.fn() }));

import { insightEligibility, questionTerms, selectQuestionSources } from './memory-ai';
import type { Note } from './types';

function note(id: string, title: string, content: string, createdAt = '2026-08-01T08:00:00.000Z'): Note {
  return {
    id, title, content, createdAt, updatedAt: createdAt, summary: null,
    status: 'saved', source: 'app', recordType: 'capture', contentKind: 'text',
    sourceUrl: null, userContext: null, sourcePageTitle: null,
    sourcePageSite: null, sourcePageText: null, tags: [],
  };
}

describe('memory AI selection', () => {
  it('removes generic recall wording and keeps useful terms', () => {
    expect(questionTerms('我之前好像记过 Loop Engineering 的东西')).toContain('loop');
    expect(questionTerms('我之前好像记过 Loop Engineering 的东西')).not.toContain('之前');
  });

  it('ranks matching notes before recent unrelated notes', () => {
    const selected = selectQuestionSources([
      note('new', '午饭', '今天吃了面', '2026-08-02T08:00:00.000Z'),
      note('match', 'Loop Engineering', '循环验证与停止条件'),
    ], '我记过 Loop Engineering 吗');
    expect(selected[0].id).toBe('match');
  });

  it('does not force an insight from too little material', () => {
    expect(insightEligibility('week', [
      { ...selectQuestionSources([note('1', '一', '足够长的第一条记录')], '一')[0] },
    ]).eligible).toBe(false);
  });
});

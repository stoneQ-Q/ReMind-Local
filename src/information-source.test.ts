import { describe, expect, it } from 'vitest';

import { informationSourceLabel } from './information-source';
import type { Note } from './types';

function note(overrides: Partial<Note>): Note {
  return {
    id: 'note-1',
    title: '测试',
    content: '内容',
    summary: null,
    status: 'ready',
    source: 'app',
    recordType: 'capture',
    contentKind: 'text',
    sourceUrl: null,
    userContext: null,
    sourcePageTitle: null,
    sourcePageSite: null,
    sourcePageText: null,
    tags: [],
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('information source label', () => {
  it('recognizes the requested external sources', () => {
    expect(
      informationSourceLabel(
        note({ sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/123' }),
      ),
    ).toBe('小宇宙');
    expect(
      informationSourceLabel(note({ sourceUrl: 'https://xhslink.com/a/123' })),
    ).toBe('小红书');
    expect(
      informationSourceLabel(
        note({ sourceUrl: 'https://mp.weixin.qq.com/s/example' }),
      ),
    ).toBe('微信公众号');
  });

  it('labels a local capture as self-authored', () => {
    expect(informationSourceLabel(note({}))).toBe('自己写的');
  });
});

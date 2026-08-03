import { describe, expect, it } from 'vitest';

import { buildMemoryTrail, filterLibraryNotes } from './library-layout';
import type { Note } from './types';

function note(overrides: Partial<Note>): Note {
  return {
    id: overrides.id ?? 'note',
    title: overrides.title ?? '标题',
    content: overrides.content ?? '正文',
    summary: overrides.summary ?? null,
    status: overrides.status ?? 'saved',
    source: overrides.source ?? 'app',
    recordType: overrides.recordType ?? 'capture',
    contentKind: overrides.contentKind ?? 'text',
    sourceUrl: overrides.sourceUrl ?? null,
    userContext: overrides.userContext ?? null,
    sourcePageTitle: overrides.sourcePageTitle ?? null,
    sourcePageSite: overrides.sourcePageSite ?? null,
    sourcePageText: overrides.sourcePageText ?? null,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? '2026-08-01T08:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-01T08:00:00.000Z',
  };
}

describe('filterLibraryNotes', () => {
  const notes = [
    note({ id: 'raw', recordType: 'capture', source: 'app' }),
    note({
      id: 'wechat-link',
      recordType: 'capture',
      source: 'wechat',
      contentKind: 'link',
    }),
    note({ id: 'source', recordType: 'source', source: 'ai' }),
    note({ id: 'theme', recordType: 'theme', source: 'ai' }),
  ];

  it('separates organized notes, themes, and raw captures', () => {
    expect(filterLibraryNotes(notes, 'organized', 'all').map(({ id }) => id))
      .toEqual(['source']);
    expect(filterLibraryNotes(notes, 'theme', 'all').map(({ id }) => id))
      .toEqual(['theme']);
    expect(filterLibraryNotes(notes, 'raw', 'all').map(({ id }) => id))
      .toEqual(['raw', 'wechat-link']);
  });

  it('applies secondary filters without mixing content stages', () => {
    expect(filterLibraryNotes(notes, 'raw', 'wechat').map(({ id }) => id))
      .toEqual(['wechat-link']);
    expect(filterLibraryNotes(notes, 'raw', 'link').map(({ id }) => id))
      .toEqual(['wechat-link']);
  });
});

describe('buildMemoryTrail', () => {
  it('builds a seven-day trail from captures and organized notes', () => {
    const now = new Date(2026, 7, 1, 18, 0, 0);
    const today = new Date(2026, 7, 1, 9, 0, 0).toISOString();
    const yesterday = new Date(2026, 6, 31, 9, 0, 0).toISOString();
    const trail = buildMemoryTrail(
      [
        note({ id: 'a', createdAt: today, tags: ['AI 工具'] }),
        note({ id: 'b', createdAt: yesterday }),
        note({
          id: 'c',
          createdAt: yesterday,
          recordType: 'source',
          tags: ['产品设计'],
        }),
      ],
      now,
    );

    expect(trail.days).toHaveLength(7);
    expect(trail.days.at(-1)).toMatchObject({
      dayLabel: '今',
      captureCount: 1,
      themeLabel: 'AI 工具',
    });
    expect(trail.days.at(-2)).toMatchObject({
      captureCount: 1,
      organizedCount: 1,
      themeLabel: '产品设计',
    });
    expect(trail).toMatchObject({ captureCount: 2, organizedCount: 1 });
  });
});

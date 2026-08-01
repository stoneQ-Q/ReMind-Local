import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({
  Directory: class {},
  File: class {},
  Paths: { document: '' },
}));

import { attachmentMap, imageExtension } from './photo-records';

describe('photo records', () => {
  it('keeps attachment order grouped by note', () => {
    const grouped = attachmentMap([
      { id: 'a', noteId: 'n1', uri: 'a.jpg', width: 10, height: 20, sortOrder: 0, createdAt: 'now' },
      { id: 'b', noteId: 'n2', uri: 'b.jpg', width: 10, height: 20, sortOrder: 0, createdAt: 'now' },
      { id: 'c', noteId: 'n1', uri: 'c.jpg', width: 10, height: 20, sortOrder: 1, createdAt: 'now' },
    ]);
    expect(grouped.n1.map(({ id }) => id)).toEqual(['a', 'c']);
  });

  it('derives safe common image extensions', () => {
    expect(imageExtension({ fileName: 'photo.JPEG', mimeType: 'image/jpeg' } as never)).toBe('jpg');
    expect(imageExtension({ fileName: null, mimeType: 'image/png' } as never)).toBe('png');
  });
});

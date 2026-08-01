import { describe, expect, it, vi } from 'vitest';

const fileDelete = vi.hoisted(() => vi.fn());

vi.mock('expo-file-system', () => ({
  Directory: class {
    uri = 'file:///documents/remind-media/';
  },
  File: class {
    exists = true;
    delete = fileDelete;
  },
  Paths: { document: 'file:///documents/' },
}));

import { attachmentMap, imageExtension, removePersistedPhotos } from './photo-records';

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

  it('only removes files persisted inside the ReMind media directory', () => {
    fileDelete.mockClear();
    removePersistedPhotos([
      { id: 'local', uri: 'file:///documents/remind-media/photo.jpg', width: 10, height: 10, sortOrder: 0 },
      { id: 'external', uri: 'file:///pictures/photo.jpg', width: 10, height: 10, sortOrder: 1 },
    ]);
    expect(fileDelete).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

const { fileCopy, fileDelete, fileWrite } = vi.hoisted(() => ({
  fileCopy: vi.fn(),
  fileDelete: vi.fn(),
  fileWrite: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: class {
    uri: string;
    exists = true;
    create = vi.fn();

    constructor(root: string, name: string) {
      this.uri = `${root}${name}/`;
    }
  },
  File: class {
    exists = true;
    size = 128;
    name = 'photo.jpg';
    uri: string;
    copy = fileCopy;
    delete = fileDelete;
    write = fileWrite;

    constructor(root: { uri?: string } | string, name?: string) {
      const base = typeof root === 'string' ? root : root.uri ?? '';
      this.uri = name ? `${base}${name}` : base;
    }

    async bytes() {
      return new Uint8Array([1, 2, 3]);
    }
  },
  Paths: {
    cache: 'file:///cache/',
    document: 'file:///documents/',
  },
}));

import {
  attachmentMap,
  imageExtension,
  materializePhotoDrafts,
  removePersistedPhotos,
  removePhotoDrafts,
} from './photo-records';

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
    expect(imageExtension({ fileName: 'photo.HEIC', mimeType: 'image/jpeg', uri: 'file:///photo.jpg' } as never)).toBe('jpg');
  });

  it('copies picker assets into a stable local draft before previewing', async () => {
    fileCopy.mockClear();
    const [draft] = await materializePhotoDrafts([
      { uri: 'content://picker/photo', fileName: 'photo.jpg', mimeType: 'image/jpeg', width: 100, height: 80 } as never,
    ]);
    expect(fileCopy).toHaveBeenCalledTimes(1);
    expect(draft.uri).toMatch(/^file:\/\/\/cache\/remind-photo-drafts\//);
  });

  it('only removes files persisted inside the ReMind media directory', () => {
    fileDelete.mockClear();
    removePersistedPhotos([
      { id: 'local', uri: 'file:///documents/remind-media/photo.jpg', width: 10, height: 10, sortOrder: 0 },
      { id: 'external', uri: 'file:///pictures/photo.jpg', width: 10, height: 10, sortOrder: 1 },
    ]);
    expect(fileDelete).toHaveBeenCalledTimes(1);
  });

  it('only removes temporary previews inside the ReMind draft directory', () => {
    fileDelete.mockClear();
    removePhotoDrafts([
      { uri: 'file:///cache/remind-photo-drafts/photo.jpg' } as never,
      { uri: 'file:///cache/another-app/photo.jpg' } as never,
    ]);
    expect(fileDelete).toHaveBeenCalledTimes(1);
  });
});

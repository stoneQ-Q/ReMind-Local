import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalFilesystemObjectStore,
  validateObjectKey,
} from './object-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('local object store adapter', () => {
  it('atomically stores, reads, materializes, and deletes an object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-objects-test-'));
    temporaryDirectories.push(directory);
    const store = new LocalFilesystemObjectStore(directory);
    const userId = randomUUID();
    const fileId = randomUUID();
    const key = `users/${userId}/temporary/${fileId}.mp3`;
    const content = Buffer.from('private media bytes');
    const materialized = join(directory, 'materialized.mp3');

    await store.put(key, content);
    expect(await store.read(key, content.byteLength)).toEqual(content);
    await store.copyToFile(key, materialized, content.byteLength);
    expect(await readFile(materialized)).toEqual(content);
    await store.delete(key);
    await expect(store.read(key, content.byteLength)).rejects.toThrow();
  });

  it('rejects traversal, invalid roots, duplicate keys, and unsafe limits', async () => {
    expect(() => new LocalFilesystemObjectStore('relative/path')).toThrow();
    expect(() => validateObjectKey('../secret')).toThrow();

    const directory = await mkdtemp(join(tmpdir(), 'remind-objects-test-'));
    temporaryDirectories.push(directory);
    const store = new LocalFilesystemObjectStore(directory);
    const key = `users/${randomUUID()}/source/${randomUUID()}.jpg`;
    await store.put(key, Buffer.from('first'));

    await expect(store.put(key, Buffer.from('second'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(store.read(key, 0)).rejects.toThrow(
      'invalid_object_size_limit',
    );
    expect(await store.read(key, 5)).toEqual(Buffer.from('first'));
  });

  it('resumes chunks by offset and completes atomically and idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-objects-test-'));
    temporaryDirectories.push(directory);
    const store = new LocalFilesystemObjectStore(directory);
    const uploadId = randomUUID();
    const key =
      `users/${randomUUID()}/source/${randomUUID()}.mp4`;
    const first = Buffer.from('first-');
    const second = Buffer.from('second');
    const content = Buffer.concat([first, second]);
    const digest = createHash('sha256').update(content).digest('hex');

    expect(await store.appendUploadChunk(uploadId, 0, first)).toBe(first.length);
    expect(await store.appendUploadChunk(uploadId, 0, first)).toBe(first.length);
    expect(
      await store.appendUploadChunk(uploadId, first.length, second),
    ).toBe(content.length);
    expect(
      await store.readUploadPrefix(uploadId, key, 5),
    ).toEqual(content.subarray(0, 5));
    await store.completeUpload(uploadId, key, content.length, digest);
    await store.completeUpload(uploadId, key, content.length, digest);
    expect(await store.read(key, content.length)).toEqual(content);
  });

  it('aborts unfinished staging data without creating an object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-objects-test-'));
    temporaryDirectories.push(directory);
    const store = new LocalFilesystemObjectStore(directory);
    const uploadId = randomUUID();
    await store.appendUploadChunk(uploadId, 0, Buffer.from('unfinished'));
    await store.abortUpload(uploadId);
    await store.abortUpload(uploadId);
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalFilesystemObjectStore,
  objectStoreFromEnvironment,
  TencentCosObjectStore,
  type TencentCosClient,
  validateObjectKey,
} from './object-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

class FakeTencentCosClient implements TencentCosClient {
  readonly objects = new Map<
    string,
    { content: Buffer; sha256Hex: string }
  >();

  async head(objectKey: string) {
    const object = this.objects.get(objectKey);
    return object
      ? {
          contentLength: object.content.byteLength,
          sha256Hex: object.sha256Hex,
          serverSideEncryption: 'AES256',
        }
      : null;
  }

  async put(
    objectKey: string,
    content: Uint8Array,
    sha256Hex: string,
  ) {
    this.objects.set(objectKey, {
      content: Buffer.from(content),
      sha256Hex,
    });
  }

  async putFile(
    objectKey: string,
    sourcePath: string,
    contentLength: number,
    sha256Hex: string,
  ) {
    const content = await readFile(sourcePath);
    if (content.byteLength !== contentLength) {
      throw new Error('fake_size_mismatch');
    }
    await this.put(objectKey, content, sha256Hex);
  }

  async get(objectKey: string) {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error('fake_not_found');
    return Buffer.from(object.content);
  }

  async getPrefix(objectKey: string, maximumBytes: number) {
    return (await this.get(objectKey)).subarray(0, maximumBytes);
  }

  async download(objectKey: string, destinationPath: string) {
    await writeFile(destinationPath, await this.get(objectKey), {
      flag: 'wx',
      mode: 0o600,
    });
  }

  async delete(objectKey: string) {
    this.objects.delete(objectKey);
  }
}

function createTencentStore(
  stagingRoot: string,
  client = new FakeTencentCosClient(),
) {
  return {
    client,
    store: new TencentCosObjectStore({
      bucket: 'remind-private-test-1250000000',
      region: 'ap-hongkong',
      secretId: 'test-secret-id',
      secretKey: 'test-secret-key',
      stagingRoot,
      client,
    }),
  };
}

describe('Tencent COS object store adapter', () => {
  it('stores private object data and materializes it through the adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-cos-test-'));
    temporaryDirectories.push(directory);
    const { client, store } = createTencentStore(directory);
    const key =
      `users/${randomUUID()}/result/${randomUUID()}.jpg`;
    const content = Buffer.from('encrypted by COS at rest');
    const materialized = join(directory, 'materialized.jpg');

    await store.put(key, content);
    expect(client.objects.get(key)?.sha256Hex).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    expect(await store.read(key, content.byteLength)).toEqual(content);
    await store.copyToFile(key, materialized, content.byteLength);
    expect(await readFile(materialized)).toEqual(content);
    await expect(store.put(key, content)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await store.delete(key);
    await store.delete(key);
  });

  it('stages resumable chunks locally and completes idempotently in COS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-cos-test-'));
    temporaryDirectories.push(directory);
    const { client, store } = createTencentStore(directory);
    const uploadId = randomUUID();
    const key =
      `users/${randomUUID()}/source/${randomUUID()}.mp4`;
    const first = Buffer.from('first-');
    const second = Buffer.from('second');
    const content = Buffer.concat([first, second]);
    const digest = createHash('sha256').update(content).digest('hex');

    expect(await store.appendUploadChunk(uploadId, 0, first)).toBe(
      first.byteLength,
    );
    expect(
      await store.appendUploadChunk(uploadId, first.byteLength, second),
    ).toBe(content.byteLength);
    expect(await store.readUploadPrefix(uploadId, key, 5)).toEqual(
      content.subarray(0, 5),
    );
    await store.completeUpload(
      uploadId,
      key,
      content.byteLength,
      digest,
    );
    await store.completeUpload(
      uploadId,
      key,
      content.byteLength,
      digest,
    );
    expect(client.objects.get(key)?.content).toEqual(content);
    expect(await store.readUploadPrefix(uploadId, key, 5)).toEqual(
      content.subarray(0, 5),
    );
  });

  it('rejects unsafe COS configuration and selects providers explicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-cos-test-'));
    temporaryDirectories.push(directory);
    expect(
      () =>
        new TencentCosObjectStore({
          bucket: 'public-looking-bucket',
          region: 'http://attacker.example',
          secretId: 'short',
          secretKey: 'short',
          stagingRoot: directory,
        }),
    ).toThrow();

    vi.stubEnv('REMIND_OBJECT_STORE_PROVIDER', 'tencent_cos');
    vi.stubEnv('REMIND_OBJECT_STORE_ROOT', directory);
    vi.stubEnv(
      'REMIND_COS_BUCKET',
      'remind-private-test-1250000000',
    );
    vi.stubEnv('REMIND_COS_REGION', 'ap-hongkong');
    vi.stubEnv('REMIND_COS_SECRET_ID', 'test-secret-id');
    vi.stubEnv('REMIND_COS_SECRET_KEY', 'test-secret-key');
    expect(objectStoreFromEnvironment().provider).toBe('tencent_cos');

    vi.stubEnv('REMIND_OBJECT_STORE_PROVIDER', 'unknown');
    expect(() => objectStoreFromEnvironment()).toThrow(
      'REMIND_OBJECT_STORE_PROVIDER must be local or tencent_cos',
    );
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BackupCosStore,
  backupObjectKeyForPath,
  type BackupCosClient,
} from './backup-cos.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class FakeBackupCosClient implements BackupCosClient {
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

  async putFile(
    objectKey: string,
    sourcePath: string,
    contentLength: number,
    sha256Hex: string,
  ) {
    const content = await readFile(sourcePath);
    expect(content.byteLength).toBe(contentLength);
    this.objects.set(objectKey, { content, sha256Hex });
  }

  async download(objectKey: string, destinationPath: string) {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error('fake_not_found');
    await writeFile(destinationPath, object.content, {
      flag: 'wx',
      mode: 0o600,
    });
  }
}

describe('encrypted backup COS store', () => {
  it('uploads, verifies, and downloads without requiring delete or list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-backup-cos-'));
    temporaryDirectories.push(directory);
    const source = join(directory, 'encrypted.dump');
    const destination = join(directory, 'downloaded.dump');
    const content = Buffer.from('authenticated encrypted backup');
    await writeFile(source, content);
    const client = new FakeBackupCosClient();
    const store = new BackupCosStore({
      bucket: 'remind-db-backup-sg-1385855631',
      region: 'ap-singapore',
      secretId: 'test-secret-id',
      secretKey: 'test-secret-key',
      client,
    });
    const objectKey = 'postgres/remind-20260730T170000Z.dump.enc';

    await store.upload(objectKey, source);
    expect(client.objects.get(objectKey)?.sha256Hex).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    await store.download(objectKey, destination);
    expect(await readFile(destination)).toEqual(content);
    await expect(store.upload(objectKey, source)).rejects.toThrow(
      'backup_object_already_exists',
    );
  });

  it('accepts only timestamped PostgreSQL backup object keys', () => {
    expect(
      backupObjectKeyForPath('/backups/remind-20260730T170000Z.dump'),
    ).toBe('postgres/remind-20260730T170000Z.dump.enc');
    expect(() => backupObjectKeyForPath('/backups/arbitrary.dump')).toThrow(
      'backup_filename_invalid',
    );
  });
});

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  backupEncryptionKeyFromEnvironment,
  decryptBackupFile,
  encryptBackupFile,
} from './backup-crypto.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('encrypted database backup format', () => {
  it('round-trips a backup and rejects the wrong key', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'source.dump');
    const encrypted = join(directory, 'backup.dump.enc');
    const restored = join(directory, 'restored.dump');
    const wrong = join(directory, 'wrong.dump');
    const key = randomBytes(32);
    const content = randomBytes(128 * 1024);
    await writeFile(source, content);

    await encryptBackupFile(source, encrypted, key);
    expect(await readFile(encrypted)).not.toContain(content);
    await decryptBackupFile(encrypted, restored, key);
    expect(await readFile(restored)).toEqual(content);
    await expect(
      decryptBackupFile(encrypted, wrong, randomBytes(32)),
    ).rejects.toThrow('encrypted_backup_authentication_failed');
    await expect(readFile(wrong)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects malformed keys and authenticated ciphertext changes', async () => {
    expect(() => backupEncryptionKeyFromEnvironment('short')).toThrow(
      'REMIND_BACKUP_ENCRYPTION_KEY_BASE64 is invalid',
    );
    expect(
      backupEncryptionKeyFromEnvironment(randomBytes(32).toString('base64')),
    ).toHaveLength(32);

    const directory = await temporaryDirectory();
    const source = join(directory, 'source.dump');
    const encrypted = join(directory, 'backup.dump.enc');
    const restored = join(directory, 'restored.dump');
    const key = randomBytes(32);
    await writeFile(source, Buffer.from('database backup'));
    await encryptBackupFile(source, encrypted, key);
    const tampered = await readFile(encrypted);
    const tamperedIndex = Math.floor(tampered.byteLength / 2);
    tampered[tamperedIndex] = (tampered[tamperedIndex] ?? 0) ^ 1;
    await writeFile(encrypted, tampered);
    await expect(
      decryptBackupFile(encrypted, restored, key),
    ).rejects.toThrow('encrypted_backup_authentication_failed');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remind-backup-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

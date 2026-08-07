import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  open,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('REMIND-BACKUP-V1\n', 'ascii');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.byteLength + IV_BYTES;

export function backupEncryptionKeyFromEnvironment(
  value = process.env.REMIND_BACKUP_ENCRYPTION_KEY_BASE64,
): Buffer {
  const normalized = value?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) {
    throw new Error('REMIND_BACKUP_ENCRYPTION_KEY_BASE64 is invalid');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.byteLength !== 32) {
    throw new Error('REMIND_BACKUP_ENCRYPTION_KEY_BASE64 is invalid');
  }
  return key;
}

export async function encryptBackupFile(
  sourcePath: string,
  destinationPath: string,
  key: Uint8Array,
): Promise<void> {
  requireKey(key);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);

  await writeFile(destinationPath, header, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await pipeline(
      createReadStream(sourcePath),
      cipher,
      createWriteStream(destinationPath, {
        flags: 'a',
        mode: 0o600,
      }),
    );
    await appendFile(destinationPath, cipher.getAuthTag());
  } catch (error) {
    await unlink(destinationPath).catch(ignoreMissing);
    throw error;
  }
}

export async function decryptBackupFile(
  sourcePath: string,
  destinationPath: string,
  key: Uint8Array,
): Promise<void> {
  requireKey(key);
  const metadata = await stat(sourcePath);
  if (metadata.size <= HEADER_BYTES + AUTH_TAG_BYTES) {
    throw new Error('encrypted_backup_invalid');
  }

  const handle = await open(sourcePath, 'r');
  let header: Buffer;
  let authTag: Buffer;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    authTag = Buffer.alloc(AUTH_TAG_BYTES);
    const headerRead = await handle.read(header, 0, HEADER_BYTES, 0);
    const tagRead = await handle.read(
      authTag,
      0,
      AUTH_TAG_BYTES,
      metadata.size - AUTH_TAG_BYTES,
    );
    if (
      headerRead.bytesRead !== HEADER_BYTES ||
      tagRead.bytesRead !== AUTH_TAG_BYTES ||
      !header.subarray(0, MAGIC.byteLength).equals(MAGIC)
    ) {
      throw new Error('encrypted_backup_invalid');
    }
  } finally {
    await handle.close();
  }

  const iv = header.subarray(MAGIC.byteLength);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(authTag);

  try {
    await pipeline(
      createReadStream(sourcePath, {
        start: HEADER_BYTES,
        end: metadata.size - AUTH_TAG_BYTES - 1,
      }),
      decipher,
      createWriteStream(destinationPath, {
        flags: 'wx',
        mode: 0o600,
      }),
    );
  } catch {
    await unlink(destinationPath).catch(ignoreMissing);
    throw new Error('encrypted_backup_authentication_failed');
  }
}

function requireKey(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new Error('backup_encryption_key_invalid');
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

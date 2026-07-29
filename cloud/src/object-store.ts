import { randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_OBJECT_BYTES = 1_073_741_824;
const OBJECT_KEY_PATTERN =
  /^users\/[0-9a-f-]{36}\/(?:source|temporary|result)\/[0-9a-f-]{36}\.[a-z0-9]{1,10}$/;

export interface ObjectStore {
  readonly provider: 'local' | 'tencent_cos' | 'aliyun_oss';
  put(objectKey: string, content: Uint8Array): Promise<void>;
  read(objectKey: string, maximumBytes: number): Promise<Buffer>;
  copyToFile(
    objectKey: string,
    destinationPath: string,
    maximumBytes: number,
  ): Promise<void>;
  delete(objectKey: string): Promise<void>;
}

export class LocalFilesystemObjectStore implements ObjectStore {
  readonly provider = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    if (!root.trim() || !isAbsolute(root)) {
      throw new Error('Object store root must be an absolute path');
    }
    this.root = resolve(root);
  }

  async put(objectKey: string, content: Uint8Array): Promise<void> {
    validateObjectKey(objectKey);
    if (content.byteLength > MAX_OBJECT_BYTES) {
      throw new Error('object_too_large');
    }
    const target = this.objectPath(objectKey);
    const temporary = `${target}.upload-${randomUUID()}`;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, target);
    } finally {
      await unlink(temporary).catch(ignoreMissing);
    }
  }

  async read(objectKey: string, maximumBytes: number): Promise<Buffer> {
    const target = this.objectPath(objectKey);
    const safeMaximum = validMaximum(maximumBytes);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > safeMaximum) {
      throw new Error('object_size_mismatch');
    }
    const content = await readFile(target);
    if (content.byteLength > safeMaximum) throw new Error('object_too_large');
    return content;
  }

  async copyToFile(
    objectKey: string,
    destinationPath: string,
    maximumBytes: number,
  ): Promise<void> {
    if (!isAbsolute(destinationPath)) {
      throw new Error('Destination path must be absolute');
    }
    const source = this.objectPath(objectKey);
    const metadata = await stat(source);
    if (!metadata.isFile() || metadata.size > validMaximum(maximumBytes)) {
      throw new Error('object_size_mismatch');
    }
    await copyFile(source, destinationPath);
  }

  async delete(objectKey: string): Promise<void> {
    await unlink(this.objectPath(objectKey)).catch(ignoreMissing);
  }

  private objectPath(objectKey: string): string {
    validateObjectKey(objectKey);
    const target = resolve(this.root, ...objectKey.split('/'));
    const child = relative(this.root, target);
    if (!child || child.startsWith(`..${sep}`) || child === '..') {
      throw new Error('invalid_object_key');
    }
    return target;
  }
}

export function objectStoreFromEnvironment(): ObjectStore {
  const root =
    process.env.REMIND_OBJECT_STORE_ROOT?.trim() ??
    '/var/lib/remind/objects';
  return new LocalFilesystemObjectStore(root);
}

export function validateObjectKey(objectKey: string): void {
  if (
    objectKey.length > 512 ||
    !OBJECT_KEY_PATTERN.test(objectKey) ||
    objectKey.includes('..')
  ) {
    throw new Error('invalid_object_key');
  }
}

function validMaximum(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_OBJECT_BYTES
  ) {
    throw new Error('invalid_object_size_limit');
  }
  return value;
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

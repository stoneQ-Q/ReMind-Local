import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
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

export interface ResumableObjectStore extends ObjectStore {
  readonly uploadStrategy: 'proxy_chunks';
  appendUploadChunk(
    uploadId: string,
    expectedOffset: number,
    content: Uint8Array,
  ): Promise<number>;
  readUploadPrefix(
    uploadId: string,
    objectKey: string,
    maximumBytes: number,
  ): Promise<Buffer>;
  completeUpload(
    uploadId: string,
    objectKey: string,
    expectedSize: number,
    expectedSha256Hex: string,
  ): Promise<void>;
  abortUpload(uploadId: string): Promise<void>;
}

/**
 * Boundary for future COS/OSS direct multipart adapters. Signed requests are
 * returned to the authenticated client; provider credentials remain server-side.
 */
export interface ProviderMultipartObjectStore extends ObjectStore {
  readonly uploadStrategy: 'provider_multipart';
  createProviderUpload(objectKey: string): Promise<{
    providerUploadId: string;
  }>;
  signProviderUploadPart(
    objectKey: string,
    providerUploadId: string,
    partNumber: number,
  ): Promise<{ url: string; expiresAt: string }>;
  completeProviderUpload(
    objectKey: string,
    providerUploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ): Promise<void>;
  abortProviderUpload(
    objectKey: string,
    providerUploadId: string,
  ): Promise<void>;
}

export class LocalFilesystemObjectStore implements ResumableObjectStore {
  readonly provider = 'local' as const;
  readonly uploadStrategy = 'proxy_chunks' as const;
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

  async appendUploadChunk(
    uploadId: string,
    expectedOffset: number,
    content: Uint8Array,
  ): Promise<number> {
    validateUploadId(uploadId);
    if (
      !Number.isSafeInteger(expectedOffset) ||
      expectedOffset < 0 ||
      content.byteLength < 1 ||
      content.byteLength > 8_388_608
    ) {
      throw new Error('invalid_upload_chunk');
    }
    const target = this.uploadPath(uploadId);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, 'a+', 0o600);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size < expectedOffset) {
        throw new Error('upload_storage_offset_mismatch');
      }
      if (metadata.size > expectedOffset) {
        await handle.truncate(expectedOffset);
      }
      await handle.write(content, 0, content.byteLength, expectedOffset);
      await handle.sync();
      return expectedOffset + content.byteLength;
    } finally {
      await handle.close();
    }
  }

  async completeUpload(
    uploadId: string,
    objectKey: string,
    expectedSize: number,
    expectedSha256Hex: string,
  ): Promise<void> {
    validateUploadId(uploadId);
    validateObjectKey(objectKey);
    const safeMaximum = validMaximum(expectedSize);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256Hex)) {
      throw new Error('invalid_upload_digest');
    }
    const source = this.uploadPath(uploadId);
    const target = this.objectPath(objectKey);
    const sourceValid = await fileMatches(
      source,
      safeMaximum,
      expectedSha256Hex,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    if (!sourceValid) {
      const targetValid = await fileMatches(
        target,
        safeMaximum,
        expectedSha256Hex,
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      });
      if (targetValid) return;
      throw new Error('upload_integrity_mismatch');
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await link(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await fileMatches(target, safeMaximum, expectedSha256Hex))) {
        throw new Error('upload_target_conflict');
      }
    }
    await unlink(source).catch(ignoreMissing);
  }

  async readUploadPrefix(
    uploadId: string,
    objectKey: string,
    maximumBytes: number,
  ): Promise<Buffer> {
    validateUploadId(uploadId);
    validateObjectKey(objectKey);
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 4_096
    ) {
      throw new Error('invalid_upload_prefix_size');
    }
    const staging = this.uploadPath(uploadId);
    const target = this.objectPath(objectKey);
    let handle;
    try {
      handle = await open(staging, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      handle = await open(target, 'r');
    }
    try {
      const buffer = Buffer.alloc(maximumBytes);
      const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async abortUpload(uploadId: string): Promise<void> {
    validateUploadId(uploadId);
    await unlink(this.uploadPath(uploadId)).catch(ignoreMissing);
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

  private uploadPath(uploadId: string): string {
    validateUploadId(uploadId);
    return resolve(this.root, '.uploads', `${uploadId}.part`);
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

export function isResumableObjectStore(
  store: ObjectStore,
): store is ResumableObjectStore {
  return (
    'uploadStrategy' in store &&
    store.uploadStrategy === 'proxy_chunks' &&
    'appendUploadChunk' in store &&
    typeof store.appendUploadChunk === 'function' &&
    'readUploadPrefix' in store &&
    typeof store.readUploadPrefix === 'function' &&
    'completeUpload' in store &&
    typeof store.completeUpload === 'function' &&
    'abortUpload' in store &&
    typeof store.abortUpload === 'function'
  );
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

function validateUploadId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error('invalid_upload_id');
  }
}

async function fileMatches(
  path: string,
  expectedSize: number,
  expectedSha256Hex: string,
): Promise<boolean> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== expectedSize) return false;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex') === expectedSha256Hex;
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
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
import { finished } from 'node:stream/promises';

import COS from 'cos-nodejs-sdk-v5';

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

export interface TemporaryReadUrlObjectStore extends ObjectStore {
  temporaryReadUrl(objectKey: string, expiresSeconds: number): Promise<string>;
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

type TencentCosObjectMetadata = {
  contentLength: number;
  sha256Hex: string | null;
  serverSideEncryption: string | null;
};

export interface TencentCosClient {
  head(objectKey: string): Promise<TencentCosObjectMetadata | null>;
  put(
    objectKey: string,
    content: Uint8Array,
    sha256Hex: string,
  ): Promise<void>;
  putFile(
    objectKey: string,
    sourcePath: string,
    contentLength: number,
    sha256Hex: string,
  ): Promise<void>;
  get(objectKey: string): Promise<Buffer>;
  getPrefix(objectKey: string, maximumBytes: number): Promise<Buffer>;
  download(objectKey: string, destinationPath: string): Promise<void>;
  delete(objectKey: string): Promise<void>;
  temporaryReadUrl?(objectKey: string, expiresSeconds: number): string;
}

type TencentCosObjectStoreOptions = {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
  stagingRoot: string;
  client?: TencentCosClient;
};

export class TencentCosObjectStore implements ResumableObjectStore {
  readonly provider = 'tencent_cos' as const;
  readonly uploadStrategy = 'proxy_chunks' as const;
  private readonly client: TencentCosClient;
  private readonly stagingRoot: string;

  constructor(options: TencentCosObjectStoreOptions) {
    const bucket = requireCosBucket(options.bucket);
    const region = requireCosRegion(options.region);
    const secretId = requireCosCredential(options.secretId, 'SecretId');
    const secretKey = requireCosCredential(options.secretKey, 'SecretKey');
    const securityToken = options.securityToken?.trim() || undefined;
    if (!options.stagingRoot.trim() || !isAbsolute(options.stagingRoot)) {
      throw new Error('COS staging root must be an absolute path');
    }
    this.stagingRoot = resolve(options.stagingRoot);
    this.client =
      options.client ??
      new TencentCosSdkClient({
        bucket,
        region,
        secretId,
        secretKey,
        securityToken,
      });
  }

  async put(objectKey: string, content: Uint8Array): Promise<void> {
    validateObjectKey(objectKey);
    if (content.byteLength > MAX_OBJECT_BYTES) {
      throw new Error('object_too_large');
    }
    if (await this.client.head(objectKey)) throw objectAlreadyExists();
    const digest = createHash('sha256').update(content).digest('hex');
    await this.client.put(objectKey, content, digest);
    await this.requireRemoteMatch(objectKey, content.byteLength, digest);
  }

  async read(objectKey: string, maximumBytes: number): Promise<Buffer> {
    validateObjectKey(objectKey);
    const safeMaximum = validMaximum(maximumBytes);
    const metadata = await this.client.head(objectKey);
    if (
      !metadata ||
      metadata.serverSideEncryption !== 'AES256' ||
      metadata.contentLength > safeMaximum
    ) {
      throw new Error('object_size_mismatch');
    }
    const content = await this.client.get(objectKey);
    if (
      content.byteLength !== metadata.contentLength ||
      content.byteLength > safeMaximum
    ) {
      throw new Error('object_size_mismatch');
    }
    return content;
  }

  async temporaryReadUrl(
    objectKey: string,
    expiresSeconds: number,
  ): Promise<string> {
    validateObjectKey(objectKey);
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 3_600) {
      throw new Error('invalid_temporary_read_url_expiry');
    }
    if (!this.client.temporaryReadUrl) {
      throw new Error('temporary_read_url_unavailable');
    }
    return this.client.temporaryReadUrl(objectKey, expiresSeconds);
  }

  async copyToFile(
    objectKey: string,
    destinationPath: string,
    maximumBytes: number,
  ): Promise<void> {
    validateObjectKey(objectKey);
    if (!isAbsolute(destinationPath)) {
      throw new Error('Destination path must be an absolute path');
    }
    const safeMaximum = validMaximum(maximumBytes);
    const metadata = await this.client.head(objectKey);
    if (
      !metadata ||
      metadata.serverSideEncryption !== 'AES256' ||
      metadata.contentLength > safeMaximum
    ) {
      throw new Error('object_size_mismatch');
    }
    const temporary = `${destinationPath}.cos-${randomUUID()}`;
    try {
      await this.client.download(objectKey, temporary);
      const downloaded = await stat(temporary);
      if (
        !downloaded.isFile() ||
        downloaded.size !== metadata.contentLength ||
        downloaded.size > safeMaximum
      ) {
        throw new Error('object_size_mismatch');
      }
      await link(temporary, destinationPath);
    } finally {
      await unlink(temporary).catch(ignoreMissing);
    }
  }

  async delete(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    await this.client.delete(objectKey);
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
    try {
      const handle = await open(this.uploadPath(uploadId), 'r');
      try {
        const buffer = Buffer.alloc(maximumBytes);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          maximumBytes,
          0,
        );
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.client.getPrefix(objectKey, maximumBytes);
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
    const sourceValid = await fileMatches(
      source,
      safeMaximum,
      expectedSha256Hex,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    const existing = await this.client.head(objectKey);
    if (existing) {
      if (
        existing.contentLength === safeMaximum &&
        existing.sha256Hex === expectedSha256Hex &&
        existing.serverSideEncryption === 'AES256'
      ) {
        await unlink(source).catch(ignoreMissing);
        return;
      }
      throw new Error('upload_target_conflict');
    }
    if (!sourceValid) throw new Error('upload_integrity_mismatch');
    await this.client.putFile(
      objectKey,
      source,
      safeMaximum,
      expectedSha256Hex,
    );
    await this.requireRemoteMatch(
      objectKey,
      safeMaximum,
      expectedSha256Hex,
    );
    await unlink(source).catch(ignoreMissing);
  }

  async abortUpload(uploadId: string): Promise<void> {
    validateUploadId(uploadId);
    await unlink(this.uploadPath(uploadId)).catch(ignoreMissing);
  }

  private uploadPath(uploadId: string): string {
    validateUploadId(uploadId);
    return resolve(this.stagingRoot, '.uploads', `${uploadId}.part`);
  }

  private async requireRemoteMatch(
    objectKey: string,
    expectedSize: number,
    expectedSha256Hex: string,
  ): Promise<void> {
    const stored = await this.client.head(objectKey);
    if (
      !stored ||
      stored.contentLength !== expectedSize ||
      stored.sha256Hex !== expectedSha256Hex ||
      stored.serverSideEncryption !== 'AES256'
    ) {
      throw new Error('object_integrity_mismatch');
    }
  }
}

class TencentCosSdkClient implements TencentCosClient {
  private readonly sdk: COS;

  constructor(
    private readonly options: {
      bucket: string;
      region: string;
      secretId: string;
      secretKey: string;
      securityToken?: string;
    },
  ) {
    this.sdk = new COS({
      SecretId: options.secretId,
      SecretKey: options.secretKey,
      SecurityToken: options.securityToken,
      Protocol: 'https:',
      StrictSsl: true,
      FollowRedirect: false,
      ForceSignHost: true,
      Timeout: 30_000,
      KeepAlive: true,
    });
  }

  async head(objectKey: string): Promise<TencentCosObjectMetadata | null> {
    try {
      const result = await this.sdk.headObject(this.params(objectKey));
      const headers = result.headers as Record<string, unknown> | undefined;
      const contentLength = Number(
        headerValue(headers, 'content-length') ?? Number.NaN,
      );
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_OBJECT_BYTES
      ) {
        throw new Error('cos_invalid_object_metadata');
      }
      const sha256Hex =
        headerValue(headers, 'x-cos-meta-remind-sha256')
          ?.trim()
          .toLowerCase() ?? null;
      const serverSideEncryption =
        headerValue(headers, 'x-cos-server-side-encryption')?.trim() ??
        null;
      return {
        contentLength,
        sha256Hex:
          sha256Hex && /^[a-f0-9]{64}$/.test(sha256Hex)
            ? sha256Hex
            : null,
        serverSideEncryption,
      };
    } catch (error) {
      if (isCosNotFound(error)) return null;
      throw safeCosError(error);
    }
  }

  async put(
    objectKey: string,
    content: Uint8Array,
    sha256Hex: string,
  ): Promise<void> {
    try {
      await this.sdk.putObject({
        ...this.params(objectKey),
        Body: Buffer.from(content),
        ContentLength: content.byteLength,
        ServerSideEncryption: 'AES256',
        'x-cos-meta-remind-sha256': sha256Hex,
      });
    } catch (error) {
      throw safeCosError(error);
    }
  }

  async get(objectKey: string): Promise<Buffer> {
    try {
      const result = await this.sdk.getObject(this.params(objectKey));
      return Buffer.from(result.Body);
    } catch (error) {
      throw safeCosError(error);
    }
  }

  temporaryReadUrl(objectKey: string, expiresSeconds: number): string {
    return this.sdk.getObjectUrl({
      ...this.params(objectKey),
      Sign: true,
      Method: 'GET',
      Expires: expiresSeconds,
      Protocol: 'https:',
    });
  }

  async putFile(
    objectKey: string,
    sourcePath: string,
    contentLength: number,
    sha256Hex: string,
  ): Promise<void> {
    try {
      await this.sdk.putObject({
        ...this.params(objectKey),
        Body: createReadStream(sourcePath),
        ContentLength: contentLength,
        ServerSideEncryption: 'AES256',
        'x-cos-meta-remind-sha256': sha256Hex,
      });
    } catch (error) {
      throw safeCosError(error);
    }
  }

  async getPrefix(
    objectKey: string,
    maximumBytes: number,
  ): Promise<Buffer> {
    try {
      const result = await this.sdk.getObject({
        ...this.params(objectKey),
        Range: `bytes=0-${maximumBytes - 1}`,
      });
      const content = Buffer.from(result.Body);
      if (content.byteLength > maximumBytes) {
        throw new Error('cos_invalid_range_response');
      }
      return content;
    } catch (error) {
      throw safeCosError(error);
    }
  }

  async download(
    objectKey: string,
    destinationPath: string,
  ): Promise<void> {
    const output = createWriteStream(destinationPath, {
      flags: 'wx',
      mode: 0o600,
    });
    try {
      await this.sdk.getObject({
        ...this.params(objectKey),
        Output: output,
      });
      await finished(output);
    } catch (error) {
      output.destroy();
      await finished(output).catch(() => undefined);
      await unlink(destinationPath).catch(ignoreMissing);
      throw safeCosError(error);
    }
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await this.sdk.deleteObject(this.params(objectKey));
    } catch (error) {
      if (!isCosNotFound(error)) throw safeCosError(error);
    }
  }

  private params(objectKey: string) {
    return {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: objectKey,
    };
  }
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
  const provider =
    process.env.REMIND_OBJECT_STORE_PROVIDER?.trim() || 'local';
  if (provider === 'tencent_cos') {
    return new TencentCosObjectStore({
      bucket: process.env.REMIND_COS_BUCKET ?? '',
      region: process.env.REMIND_COS_REGION ?? '',
      secretId: process.env.REMIND_COS_SECRET_ID ?? '',
      secretKey: process.env.REMIND_COS_SECRET_KEY ?? '',
      securityToken: process.env.REMIND_COS_SECURITY_TOKEN,
      stagingRoot: root,
    });
  }
  if (provider !== 'local') {
    throw new Error(
      'REMIND_OBJECT_STORE_PROVIDER must be local or tencent_cos',
    );
  }
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

function requireCosBucket(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 60 ||
    !/^[a-z0-9][a-z0-9-]*-[0-9]{5,20}$/.test(normalized)
  ) {
    throw new Error('REMIND_COS_BUCKET is invalid');
  }
  return normalized;
}

function requireCosRegion(value: string): string {
  const normalized = value.trim();
  if (!/^ap-[a-z0-9-]{2,32}$/.test(normalized)) {
    throw new Error('REMIND_COS_REGION is invalid');
  }
  return normalized;
}

function requireCosCredential(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) {
    throw new Error(`COS ${label} is required`);
  }
  return normalized;
}

function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return null;
}

function isCosNotFound(error: unknown): boolean {
  const candidate = error as {
    statusCode?: unknown;
    code?: unknown;
  };
  return (
    candidate?.statusCode === 404 ||
    candidate?.code === 'NoSuchKey' ||
    candidate?.code === 'NoSuchResource' ||
    candidate?.code === 'NotFound'
  );
}

function safeCosError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('cos_')) {
    return error;
  }
  const candidate = error as {
    statusCode?: unknown;
    code?: unknown;
  };
  if (candidate?.statusCode === 401 || candidate?.statusCode === 403) {
    return new Error('cos_access_denied');
  }
  if (
    candidate?.code === 'RequestTimeout' ||
    candidate?.code === 'TimeoutError' ||
    candidate?.code === 'ECONNRESET' ||
    candidate?.code === 'ETIMEDOUT'
  ) {
    return new Error('cos_unavailable');
  }
  return new Error('cos_request_failed');
}

function objectAlreadyExists(): NodeJS.ErrnoException {
  const error = new Error('object_already_exists') as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  return error;
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

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

import COS from 'cos-nodejs-sdk-v5';

const MAX_BACKUP_BYTES = 17_179_869_184;
const OBJECT_KEY_PATTERN =
  /^postgres\/remind-[0-9]{8}T[0-9]{6}Z\.dump\.enc$/;

export type BackupObjectMetadata = {
  contentLength: number;
  sha256Hex: string | null;
  serverSideEncryption: string | null;
};

export interface BackupCosClient {
  head(objectKey: string): Promise<BackupObjectMetadata | null>;
  putFile(
    objectKey: string,
    sourcePath: string,
    contentLength: number,
    sha256Hex: string,
  ): Promise<void>;
  download(objectKey: string, destinationPath: string): Promise<void>;
}

type BackupCosStoreOptions = {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
  client?: BackupCosClient;
};

export class BackupCosStore {
  private readonly client: BackupCosClient;

  constructor(options: BackupCosStoreOptions) {
    const bucket = requireBucket(options.bucket);
    const region = requireRegion(options.region);
    const secretId = requireCredential(options.secretId, 'SecretId');
    const secretKey = requireCredential(options.secretKey, 'SecretKey');
    const securityToken = options.securityToken?.trim() || undefined;
    this.client =
      options.client ??
      new TencentBackupCosClient({
        bucket,
        region,
        secretId,
        secretKey,
        securityToken,
      });
  }

  async upload(objectKey: string, sourcePath: string): Promise<void> {
    validateBackupObjectKey(objectKey);
    const source = await stat(sourcePath);
    if (
      !source.isFile() ||
      source.size < 1 ||
      source.size > MAX_BACKUP_BYTES
    ) {
      throw new Error('backup_file_size_invalid');
    }
    if (await this.client.head(objectKey)) {
      throw new Error('backup_object_already_exists');
    }
    const sha256Hex = await fileSha256(sourcePath);
    await this.client.putFile(
      objectKey,
      sourcePath,
      source.size,
      sha256Hex,
    );
    const stored = await this.client.head(objectKey);
    if (
      !stored ||
      stored.contentLength !== source.size ||
      stored.sha256Hex !== sha256Hex ||
      stored.serverSideEncryption !== 'AES256'
    ) {
      throw new Error('backup_object_integrity_mismatch');
    }
  }

  async download(
    objectKey: string,
    destinationPath: string,
  ): Promise<void> {
    validateBackupObjectKey(objectKey);
    const stored = await this.client.head(objectKey);
    if (
      !stored ||
      stored.contentLength < 1 ||
      stored.contentLength > MAX_BACKUP_BYTES ||
      !stored.sha256Hex ||
      stored.serverSideEncryption !== 'AES256'
    ) {
      throw new Error('backup_object_integrity_mismatch');
    }
    await this.client.download(objectKey, destinationPath);
    const downloaded = await stat(destinationPath);
    if (
      downloaded.size !== stored.contentLength ||
      (await fileSha256(destinationPath)) !== stored.sha256Hex
    ) {
      await unlink(destinationPath).catch(ignoreMissing);
      throw new Error('backup_object_integrity_mismatch');
    }
  }
}

export function backupCosStoreFromEnvironment(): BackupCosStore {
  return new BackupCosStore({
    bucket: process.env.REMIND_BACKUP_COS_BUCKET ?? '',
    region: process.env.REMIND_BACKUP_COS_REGION ?? '',
    secretId: process.env.REMIND_BACKUP_COS_SECRET_ID ?? '',
    secretKey: process.env.REMIND_BACKUP_COS_SECRET_KEY ?? '',
    securityToken: process.env.REMIND_BACKUP_COS_SECURITY_TOKEN,
  });
}

export function backupObjectKeyForPath(sourcePath: string): string {
  const match = /(?:^|\/)(remind-[0-9]{8}T[0-9]{6}Z\.dump)$/.exec(
    sourcePath,
  );
  if (!match?.[1]) throw new Error('backup_filename_invalid');
  return `postgres/${match[1]}.enc`;
}

export function validateBackupObjectKey(objectKey: string): void {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) {
    throw new Error('backup_object_key_invalid');
  }
}

class TencentBackupCosClient implements BackupCosClient {
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
      Timeout: 60_000,
      KeepAlive: true,
    });
  }

  async head(objectKey: string): Promise<BackupObjectMetadata | null> {
    try {
      const result = await this.sdk.headObject(this.params(objectKey));
      const headers = result.headers as Record<string, unknown> | undefined;
      const contentLength = Number(
        headerValue(headers, 'content-length') ?? Number.NaN,
      );
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_BACKUP_BYTES
      ) {
        throw new Error('backup_cos_invalid_metadata');
      }
      const digest =
        headerValue(headers, 'x-cos-meta-remind-backup-sha256')
          ?.trim()
          .toLowerCase() ?? null;
      return {
        contentLength,
        sha256Hex:
          digest && /^[a-f0-9]{64}$/.test(digest) ? digest : null,
        serverSideEncryption:
          headerValue(headers, 'x-cos-server-side-encryption')?.trim() ??
          null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw safeCosError(error);
    }
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
        'x-cos-meta-remind-backup-sha256': sha256Hex,
      });
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

  private params(objectKey: string) {
    return {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: objectKey,
    };
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function requireBucket(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 60 ||
    !/^[a-z0-9][a-z0-9-]*-[0-9]{5,20}$/.test(normalized)
  ) {
    throw new Error('REMIND_BACKUP_COS_BUCKET is invalid');
  }
  return normalized;
}

function requireRegion(value: string): string {
  const normalized = value.trim();
  if (!/^ap-[a-z0-9-]{2,32}$/.test(normalized)) {
    throw new Error('REMIND_BACKUP_COS_REGION is invalid');
  }
  return normalized;
}

function requireCredential(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) {
    throw new Error(`Backup COS ${label} is required`);
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

function isNotFound(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return (
    candidate?.statusCode === 404 ||
    candidate?.code === 'NoSuchKey' ||
    candidate?.code === 'NoSuchResource' ||
    candidate?.code === 'NotFound'
  );
}

function safeCosError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('backup_cos_')) {
    return error;
  }
  const candidate = error as { statusCode?: unknown };
  const status =
    typeof candidate?.statusCode === 'number'
      ? candidate.statusCode
      : 502;
  if (status === 401 || status === 403) {
    return new Error('backup_cos_access_denied');
  }
  if (status === 404) return new Error('backup_cos_not_found');
  return new Error('backup_cos_request_failed');
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

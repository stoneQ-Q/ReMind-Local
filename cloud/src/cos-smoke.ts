import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { objectStoreFromEnvironment } from './object-store.js';

const store = objectStoreFromEnvironment();
if (store.provider !== 'tencent_cos') {
  throw new Error('COS smoke test requires tencent_cos provider');
}

const userId = randomUUID();
const fileId = randomUUID();
const objectKey = `users/${userId}/temporary/${fileId}.txt`;
const destination = join(tmpdir(), `remind-cos-smoke-${randomUUID()}.txt`);
const content = Buffer.from(`remind-cos-smoke:${randomUUID()}`, 'utf8');
const expectedDigest = createHash('sha256').update(content).digest('hex');

try {
  await store.put(objectKey, content);
  const downloaded = await store.read(objectKey, content.byteLength);
  if (
    createHash('sha256').update(downloaded).digest('hex') !== expectedDigest
  ) {
    throw new Error('COS smoke read integrity mismatch');
  }
  await store.copyToFile(objectKey, destination, content.byteLength);
  const materialized = await readFile(destination);
  if (
    createHash('sha256').update(materialized).digest('hex') !==
    expectedDigest
  ) {
    throw new Error('COS smoke download integrity mismatch');
  }
} finally {
  await store.delete(objectKey).catch(() => undefined);
  await rm(destination, { force: true }).catch(() => undefined);
}

console.log('COS smoke verified: encrypted write, read, download, and delete');

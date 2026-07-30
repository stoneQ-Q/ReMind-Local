import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backupCosStoreFromEnvironment,
  backupObjectKeyForPath,
} from './backup-cos.js';
import {
  backupEncryptionKeyFromEnvironment,
  encryptBackupFile,
} from './backup-crypto.js';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('backup source path is required');

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'remind-backup-upload-'),
);
const encryptedPath = join(temporaryDirectory, 'backup.dump.enc');
const objectKey = backupObjectKeyForPath(sourcePath);

try {
  await encryptBackupFile(
    sourcePath,
    encryptedPath,
    backupEncryptionKeyFromEnvironment(),
  );
  await backupCosStoreFromEnvironment().upload(objectKey, encryptedPath);
  console.log(`Uploaded encrypted PostgreSQL backup ${objectKey}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

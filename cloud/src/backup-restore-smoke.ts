import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  backupCosStoreFromEnvironment,
  backupObjectKeyForPath,
} from './backup-cos.js';
import {
  backupEncryptionKeyFromEnvironment,
  decryptBackupFile,
  encryptBackupFile,
} from './backup-crypto.js';

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'remind-backup-restore-'),
);
const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');
const originalDump = join(
  temporaryDirectory,
  `remind-${timestamp}.dump`,
);
const encryptedDump = `${originalDump}.enc`;
const downloadedDump = join(temporaryDirectory, 'downloaded.dump.enc');
const restoredDump = join(temporaryDirectory, 'restored.dump');
const restoreDatabase =
  `remind_restore_check_${process.pid}_${Date.now()}`.toLowerCase();
let databaseCreated = false;

try {
  await run('pg_dump', [
    '--format=custom',
    '--no-owner',
    `--file=${originalDump}`,
  ]);
  const originalDigest = await sha256(originalDump);
  const encryptionKey = backupEncryptionKeyFromEnvironment();
  await encryptBackupFile(originalDump, encryptedDump, encryptionKey);

  const store = backupCosStoreFromEnvironment();
  const objectKey = backupObjectKeyForPath(originalDump);
  await store.upload(objectKey, encryptedDump);
  await store.download(objectKey, downloadedDump);
  await decryptBackupFile(downloadedDump, restoredDump, encryptionKey);
  if ((await sha256(restoredDump)) !== originalDigest) {
    throw new Error('backup_restore_digest_mismatch');
  }

  await run('createdb', [restoreDatabase]);
  databaseCreated = true;
  await run('pg_restore', [
    '--no-owner',
    `--dbname=${restoreDatabase}`,
    restoredDump,
  ]);

  const sourceTables = await scalar(
    process.env.PGDATABASE ?? 'remind',
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
  );
  const restoredTables = await scalar(
    restoreDatabase,
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
  );
  const sourceMigrations = await scalar(
    process.env.PGDATABASE ?? 'remind',
    'SELECT count(*) FROM schema_migrations',
  );
  const restoredMigrations = await scalar(
    restoreDatabase,
    'SELECT count(*) FROM schema_migrations',
  );
  if (
    sourceTables !== restoredTables ||
    sourceMigrations !== restoredMigrations
  ) {
    throw new Error('backup_restore_database_mismatch');
  }

  console.log(
    `Encrypted backup restore verified: ${sourceTables} tables, ` +
      `${sourceMigrations} migrations, object ${objectKey}`,
  );
} finally {
  if (databaseCreated) {
    await run('dropdb', ['--if-exists', restoreDatabase]).catch(
      () => undefined,
    );
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function scalar(database: string, sql: string): Promise<string> {
  return (
    await run('psql', [
      '--dbname',
      database,
      '--tuples-only',
      '--no-align',
      '--command',
      sql,
    ])
  ).trim();
}

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once('error', () =>
      reject(new Error(`backup_command_unavailable:${command}`)),
    );
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(`backup_command_failed:${command}`));
      }
    });
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

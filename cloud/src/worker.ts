import { hostname } from 'node:os';

import {
  ByokMediaProcessingProvider,
  RemoteMediaProcessingProvider,
} from './byok-media-provider.js';
import { mediaProviderMode, workerPollMs } from './config.js';
import { credentialCipherFromEnvironment } from './credential-cipher.js';
import { closeDatabase, database } from './database.js';
import {
  processNextCancellation,
  recoverNextExpiredLease,
  runNextJob,
  type JobHandlers,
} from './jobs.js';
import {
  createLinkParseHandler,
  ensureNextLinkParseJob,
} from './link-processing.js';
import {
  createMediaProcessingHandlers,
  ensureNextMediaProcessingJob,
} from './media-processing.js';
import { managedMediaPriceCatalogFromEnvironment } from './media-pricing.js';
import {
  requiredManagedProviderCredentialsFromEnvironment,
} from './media-provider-routing.js';
import { cleanupNextExpiredObject } from './object-files.js';
import { objectStoreFromEnvironment } from './object-store.js';
import {
  createWechatPollHandler,
  ensureNextWechatPollJob,
} from './wechat-connections.js';

const pollMs = workerPollMs();
const workerId = `${hostname()}:${process.pid}`;
const credentialCipher = credentialCipherFromEnvironment();
const objectStore = objectStoreFromEnvironment();
const mediaMode = mediaProviderMode();
const mediaHandlers: JobHandlers =
  mediaMode === 'mock'
    ? createMediaProcessingHandlers(database, objectStore)
    : mediaMode === 'byok'
      ? createMediaProcessingHandlers(
          database,
          objectStore,
          new ByokMediaProcessingProvider(database, credentialCipher),
        )
      : mediaMode === 'remote'
        ? createMediaProcessingHandlers(
            database,
            objectStore,
            new RemoteMediaProcessingProvider(
              database,
              credentialCipher,
              {
                managedCredentials:
                  requiredManagedProviderCredentialsFromEnvironment(),
                managedPriceCatalog:
                  managedMediaPriceCatalogFromEnvironment(),
              },
            ),
          )
    : new Map();
const handlers: JobHandlers = new Map([
  [
    'system.noop',
    async (_job, signal) => {
      if (signal.aborted) throw signal.reason;
      return { ok: true };
    },
  ],
  ['wechat.poll', createWechatPollHandler(database, credentialCipher)],
  ['link.parse', createLinkParseHandler(database)],
  ...mediaHandlers,
]);
let stopping = false;

console.log(`ReMind cloud Worker started as ${workerId}`);
console.log(`Media processing provider: ${mediaMode}`);
void run().finally(async () => {
  await closeDatabase();
});

async function run(): Promise<void> {
  while (!stopping) {
    try {
      await cleanupNextExpiredObject(database, objectStore);
      if (await ensureNextWechatPollJob(database)) continue;
      if (await ensureNextLinkParseJob(database)) continue;
      if (
        mediaHandlers.size > 0 &&
        (await ensureNextMediaProcessingJob(database))
      ) {
        continue;
      }
      if (await recoverNextExpiredLease(database)) continue;
      if (await processNextCancellation(database)) continue;
      if (await runNextJob(database, workerId, handlers)) continue;
    } catch (error) {
      console.error(
        'Cloud Worker poll failed',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    await wait(pollMs);
  }
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; stopping cloud Worker`);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

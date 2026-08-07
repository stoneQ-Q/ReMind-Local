import { hostname } from 'node:os';

import {
  ByokMediaProcessingProvider,
  RemoteMediaProcessingProvider,
  WhisperFirstByokMediaProcessingProvider,
} from './byok-media-provider.js';
import {
  mediaProviderMode,
  whisperServiceUrl,
  workerPollMs,
} from './config.js';
import { credentialCipherFromEnvironment } from './credential-cipher.js';
import { closeDatabase, database } from './database.js';
import {
  cleanupNextExpiredFileUpload,
} from './file-uploads.js';
import {
  processNextCancellation,
  recoverNextExpiredLease,
  runNextJob,
  type JobHandlers,
} from './jobs.js';
import {
  createLinkParseHandler,
  ensureNextLinkParseJob,
  ensureNextLinkMediaRequest,
  reconcileNextLinkMediaRequest,
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
import { WhisperMediaClient } from './whisper-media-client.js';

const pollMs = workerPollMs();
const workerId = `${hostname()}:${process.pid}`;
const credentialCipher = credentialCipherFromEnvironment();
const objectStore = objectStoreFromEnvironment();
const mediaMode = mediaProviderMode();
const whisperUrl = whisperServiceUrl();
const mediaHandlers: JobHandlers =
  mediaMode === 'mock'
    ? createMediaProcessingHandlers(database, objectStore)
    : mediaMode === 'byok'
      ? createMediaProcessingHandlers(
          database,
          objectStore,
          whisperUrl
            ? new WhisperFirstByokMediaProcessingProvider(
                database,
                credentialCipher,
                new WhisperMediaClient(whisperUrl),
              )
            : new ByokMediaProcessingProvider(database, credentialCipher),
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
  ['link.parse', createLinkParseHandler(database, objectStore)],
  ...mediaHandlers,
]);
let stopping = false;

console.log(`ReMind cloud Worker started as ${workerId}`);
console.log(`Media processing provider: ${mediaMode}`);
console.log(`Server Whisper: ${whisperUrl ? 'enabled' : 'disabled'}`);
void run().finally(async () => {
  await closeDatabase();
});

async function run(): Promise<void> {
  while (!stopping) {
    try {
      await cleanupNextExpiredFileUpload(database, objectStore);
      await cleanupNextExpiredObject(database, objectStore);
      if (await ensureNextWechatPollJob(database)) continue;
      if (await ensureNextLinkParseJob(database)) continue;
      if (
        mediaHandlers.size > 0 &&
        (await ensureNextLinkMediaRequest(database, Boolean(whisperUrl)))
      ) {
        continue;
      }
      if (
        mediaHandlers.size > 0 &&
        (await ensureNextMediaProcessingJob(database))
      ) {
        continue;
      }
      if (
        mediaHandlers.size > 0 &&
        (await reconcileNextLinkMediaRequest(database))
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

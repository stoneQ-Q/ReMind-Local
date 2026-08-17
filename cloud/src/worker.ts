import { hostname } from 'node:os';

import {
  ByokMediaProcessingProvider,
  RemoteMediaProcessingProvider,
  WhisperFirstByokMediaProcessingProvider,
} from './byok-media-provider.js';
import {
  consumerManagedAiEnabled,
  dashscopeConfig,
  mediaProviderMode,
  serverWhisperUserIds,
  whisperServiceUrl,
  workerPollMs,
  xiaoyuzhouTranscriptionEnabled,
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
import {
  managedMediaPriceCatalogFromEnvironment,
  managedTranscriptionPriceCatalogFromEnvironment,
  managedTextPriceCatalogFromEnvironment,
} from './media-pricing.js';
import {
  managedProviderCredentialsFromEnvironment,
  requiredManagedProviderCredentialsFromEnvironment,
} from './media-provider-routing.js';
import { cleanupNextExpiredObject } from './object-files.js';
import { objectStoreFromEnvironment } from './object-store.js';
import { ParaformerClient } from './paraformer-client.js';
import {
  createLinkOrganizationHandler,
  LINK_ORGANIZATION_JOB_TYPE,
} from './organization-jobs.js';
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
const whisperUserIds = serverWhisperUserIds();
const whisperClient = whisperUrl ? new WhisperMediaClient(whisperUrl) : null;
if (whisperUserIds.size > 0 && !whisperClient) {
  throw new Error('Server Whisper allowlist requires REMIND_WHISPER_URL');
}
const dashscope = dashscopeConfig();
const paraformer = dashscope
  ? new ParaformerClient(dashscope.apiKey, dashscope.apiHost)
  : null;
const xiaoyuzhouAudioEnabled =
  xiaoyuzhouTranscriptionEnabled() && Boolean(paraformer);
const managedConsumerEnabled = consumerManagedAiEnabled();
const managedMediaCredentials =
  mediaMode === 'remote'
    ? requiredManagedProviderCredentialsFromEnvironment()
    : null;
const managedMediaPriceCatalog =
  mediaMode === 'remote' ? managedMediaPriceCatalogFromEnvironment() : null;
const managedTextCredentials = managedConsumerEnabled
  ? managedProviderCredentialsFromEnvironment()
  : null;
const managedTextPriceCatalog = managedConsumerEnabled
  ? managedTextPriceCatalogFromEnvironment()
  : null;
const managedTranscriptionPriceCatalog =
  managedConsumerEnabled && paraformer
    ? managedTranscriptionPriceCatalogFromEnvironment()
    : null;
if (managedConsumerEnabled && !managedTextCredentials?.deepseek) {
  throw new Error(
    'Managed consumer AI requires text pricing and a platform DeepSeek credential',
  );
}
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
                whisperClient!,
                undefined,
                undefined,
                whisperUserIds,
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
                managedCredentials: managedMediaCredentials!,
                managedPriceCatalog: managedMediaPriceCatalog!,
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
  [
    LINK_ORGANIZATION_JOB_TYPE,
    createLinkOrganizationHandler(
      database,
      credentialCipher,
      managedTextCredentials && managedTextPriceCatalog
        ? {
            credentials: managedTextCredentials,
            priceCatalog: managedTextPriceCatalog,
          }
        : undefined,
    ),
  ],
  [
    'link.parse',
    createLinkParseHandler(
      database,
      objectStore,
      undefined,
      undefined,
      xiaoyuzhouAudioEnabled ? paraformer : null,
      xiaoyuzhouAudioEnabled
        ? {
            priceCatalog: managedTranscriptionPriceCatalog,
            serverWhisperUserIds: whisperUserIds,
            whisper: whisperClient,
          }
        : null,
    ),
  ],
  ...mediaHandlers,
]);
let stopping = false;

console.log(`ReMind cloud Worker started as ${workerId}`);
console.log(`Media processing provider: ${mediaMode}`);
console.log(`Server Whisper: ${whisperUrl ? 'enabled' : 'disabled'}`);
console.log(
  `Xiaoyuzhou Paraformer: ${xiaoyuzhouAudioEnabled ? 'enabled' : 'paused'}`,
);
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

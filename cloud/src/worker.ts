import { hostname } from 'node:os';

import { workerPollMs } from './config.js';
import { closeDatabase, database } from './database.js';
import {
  processNextCancellation,
  recoverNextExpiredLease,
  runNextJob,
  type JobHandlers,
} from './jobs.js';

const pollMs = workerPollMs();
const workerId = `${hostname()}:${process.pid}`;
const handlers: JobHandlers = new Map([
  [
    'system.noop',
    async (_job, signal) => {
      if (signal.aborted) throw signal.reason;
      return { ok: true };
    },
  ],
]);
let stopping = false;

console.log(`ReMind cloud Worker started as ${workerId}`);
void run().finally(async () => {
  await closeDatabase();
});

async function run(): Promise<void> {
  while (!stopping) {
    try {
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

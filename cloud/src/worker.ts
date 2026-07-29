import { workerPollMs } from './config.js';
import { closeDatabase, database } from './database.js';
import { claimNextNoopJob, completeNoopJob } from './jobs.js';

const pollMs = workerPollMs();
let stopping = false;

console.log('ReMind cloud Worker started');
void run();

async function run(): Promise<void> {
  while (!stopping) {
    try {
      const job = await claimNextNoopJob(database);
      if (job) {
        await completeNoopJob(database, job);
        continue;
      }
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

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; shutting down cloud Worker`);
  await closeDatabase();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

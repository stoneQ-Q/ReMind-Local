export type CloudRuntimeConfig = {
  databaseUrl: string;
};

export function loadCloudRuntimeConfig(): CloudRuntimeConfig {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return { databaseUrl };
}

export function apiPort(): number {
  const value = Number(process.env.PORT ?? '8790');
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  return value;
}

export function workerPollMs(): number {
  const value = Number(process.env.REMIND_WORKER_POLL_MS ?? '1000');
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error('REMIND_WORKER_POLL_MS must be between 100 and 60000');
  }
  return value;
}

export function mediaProviderMode(): 'disabled' | 'mock' | 'byok' | 'remote' {
  const value = process.env.REMIND_MEDIA_PROVIDER?.trim() || 'disabled';
  if (
    value !== 'disabled' &&
    value !== 'mock' &&
    value !== 'byok' &&
    value !== 'remote'
  ) {
    throw new Error(
      'REMIND_MEDIA_PROVIDER must be disabled, mock, byok, or remote',
    );
  }
  return value;
}

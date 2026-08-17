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

export function releaseIdentifier(): string {
  const value = process.env.REMIND_RELEASE?.trim() || 'development';
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : 'unknown';
}

export function consumerManagedAiEnabled(): boolean {
  return booleanEnvironment('REMIND_CONSUMER_MANAGED_AI_ENABLED', false);
}

export function consumerStarterCreditMicros(): bigint {
  const normalized =
    process.env.REMIND_CONSUMER_STARTER_CREDIT_MICROS?.trim() || '0';
  if (!/^[0-9]{1,18}$/.test(normalized)) {
    throw new Error(
      'REMIND_CONSUMER_STARTER_CREDIT_MICROS must be a nonnegative integer',
    );
  }
  return BigInt(normalized);
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

export function whisperServiceUrl(): string | null {
  const value = process.env.REMIND_WHISPER_URL?.trim();
  return value || null;
}

export function xiaoyuzhouTranscriptionEnabled(): boolean {
  const value =
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED?.trim() || 'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      'REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED must be true or false',
    );
  }
  return value === 'true';
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return value === 'true';
}

export function dashscopeConfig(): {
  apiKey: string;
  apiHost: string;
} | null {
  const apiKey = process.env.REMIND_DASHSCOPE_API_KEY?.trim() || '';
  const apiHost = process.env.REMIND_DASHSCOPE_API_HOST?.trim() || '';
  if (!apiKey && !apiHost) return null;
  if (!apiKey || !apiHost) {
    throw new Error(
      'REMIND_DASHSCOPE_API_KEY and REMIND_DASHSCOPE_API_HOST must be configured together',
    );
  }
  return { apiKey, apiHost };
}

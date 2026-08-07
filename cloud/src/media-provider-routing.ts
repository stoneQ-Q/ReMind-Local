import type { Pool } from 'pg';

import {
  loadApiCredential,
  type AiProvider,
  type AiUsageMode,
} from './ai-settings.js';
import type { CredentialCipher } from './credential-cipher.js';
import { assertProviderAvailable } from './provider-health.js';

export type ManagedProviderCredentials = Readonly<
  Partial<Record<AiProvider, string>>
>;

export type ResolvedMediaProviderCredential = {
  apiKey: string;
  mode: 'bring_your_own_key' | 'managed';
  billPlatformCost: boolean;
};

export class MediaProviderAuthorizationError extends Error {
  constructor(
    readonly code:
      | 'ai_disabled'
      | 'user_provider_credential_required'
      | 'managed_provider_credential_required'
      | 'managed_reservation_required',
  ) {
    super(code);
  }
}

export async function resolveMediaProviderCredential(
  pool: Pool,
  cipher: CredentialCipher,
  input: {
    userId: string;
    provider: AiProvider;
    reservedCostMicros: bigint;
    managedCredentials?: ManagedProviderCredentials;
  },
): Promise<ResolvedMediaProviderCredential> {
  const account = await pool.query<{
    ai_mode: AiUsageMode;
    status: string;
  }>(
    `SELECT ai_mode, status
     FROM users
     WHERE id = $1`,
    [input.userId],
  );
  const user = account.rows[0];
  if (!user || user.status !== 'active' || user.ai_mode === 'disabled') {
    throw new MediaProviderAuthorizationError('ai_disabled');
  }

  const client = await pool.connect();
  try {
    await assertProviderAvailable(client, input.provider);
  } finally {
    client.release();
  }

  if (user.ai_mode === 'bring_your_own_key') {
    const apiKey = await loadApiCredential(
      pool,
      cipher,
      input.userId,
      input.provider,
    );
    if (!apiKey) {
      throw new MediaProviderAuthorizationError(
        'user_provider_credential_required',
      );
    }
    return {
      apiKey,
      mode: user.ai_mode,
      billPlatformCost: false,
    };
  }

  if (input.reservedCostMicros <= 0n) {
    throw new MediaProviderAuthorizationError('managed_reservation_required');
  }
  const apiKey = input.managedCredentials?.[input.provider]?.trim();
  if (!apiKey) {
    throw new MediaProviderAuthorizationError(
      'managed_provider_credential_required',
    );
  }
  return {
    apiKey,
    mode: user.ai_mode,
    billPlatformCost: true,
  };
}

export function managedProviderCredentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ManagedProviderCredentials {
  const deepseek = environment.REMIND_MANAGED_DEEPSEEK_API_KEY?.trim();
  const zhipu = environment.REMIND_MANAGED_ZHIPU_API_KEY?.trim();
  return {
    ...(deepseek ? { deepseek } : {}),
    ...(zhipu ? { zhipu } : {}),
  };
}

export function requiredManagedProviderCredentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Required<ManagedProviderCredentials> {
  const credentials = managedProviderCredentialsFromEnvironment(environment);
  if (!credentials.deepseek || !credentials.zhipu) {
    throw new MediaProviderAuthorizationError(
      'managed_provider_credential_required',
    );
  }
  return {
    deepseek: credentials.deepseek,
    zhipu: credentials.zhipu,
  };
}

import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import { DeepSeekMediaClient } from './media-provider-clients.js';
import { resolveMediaProviderCredential } from './media-provider-routing.js';

export async function runByokAiTest(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  signal: AbortSignal,
  client = new DeepSeekMediaClient(),
): Promise<{
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}> {
  const credential = await resolveMediaProviderCredential(pool, cipher, {
    userId,
    provider: 'deepseek',
    reservedCostMicros: 0n,
  });
  const result = await client.generateConnectivityTest(
    credential.apiKey,
    signal,
  );
  return {
    content: result.content,
    model: result.model,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  };
}

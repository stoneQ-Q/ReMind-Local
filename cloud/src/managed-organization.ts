import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  releaseJobCost,
  reserveJobCost,
  settleJobCost,
} from './billing.js';
import { createManagedJobQuote } from './job-quotes.js';
import {
  actualManagedTextCost,
  estimateManagedTextCost,
  type ManagedTextPriceCatalog,
} from './media-pricing.js';
import {
  managedProviderCredentialsFromEnvironment,
  type ManagedProviderCredentials,
} from './media-provider-routing.js';
import type { OrganizationExecution } from './organization.js';

const MAXIMUM_OUTPUT_TOKENS_WITH_RETRY = 10_000;

export async function runManagedOrganization<T>(input: {
  pool: Pool;
  userId: string;
  operation: string;
  body: unknown;
  priceCatalog: ManagedTextPriceCatalog;
  managedCredentials?: ManagedProviderCredentials;
  run: (execution: OrganizationExecution) => Promise<T>;
}): Promise<T> {
  const serialized = JSON.stringify(input.body);
  const estimatedInputTokens = Math.min(
    10_000_000,
    Math.max(1, serialized.length * 4),
  );
  const estimateMicros = estimateManagedTextCost(
    input.priceCatalog,
    estimatedInputTokens,
    MAXIMUM_OUTPUT_TOKENS_WITH_RETRY,
  );
  const requestId = randomUUID();
  const idempotencyKey = `managed-organization:${input.operation}:${requestId}`;
  const quote = await createManagedJobQuote(
    input.pool,
    input.userId,
    'ai.text',
    'deepseek',
    estimateMicros,
    idempotencyKey,
    { operation: input.operation },
  );
  await reserveJobCost(
    input.pool,
    input.userId,
    quote.jobId,
    estimateMicros,
    `${idempotencyKey}:reserve`,
  );

  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const result = await input.run({
      managedCredentials:
        input.managedCredentials ?? managedProviderCredentialsFromEnvironment(),
      reservedCostMicros: estimateMicros,
      onUsage: (usage) => {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
      },
    });
    const actualMicros = actualManagedTextCost(
      input.priceCatalog,
      promptTokens,
      completionTokens,
    );
    await settleJobCost(
      input.pool,
      input.userId,
      quote.jobId,
      actualMicros,
      idempotencyKey,
    );
    return result;
  } catch (error) {
    await releaseJobCost(
      input.pool,
      input.userId,
      quote.jobId,
      'failed',
      idempotencyKey,
    ).catch(() => undefined);
    throw error;
  }
}

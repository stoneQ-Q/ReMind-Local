import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import type { ClaimedJob, JobHandler } from './jobs.js';
import { organizeLink } from './organization.js';
import { runManagedOrganization } from './managed-organization.js';
import type { ManagedTextPriceCatalog } from './media-pricing.js';
import type { ManagedProviderCredentials } from './media-provider-routing.js';

export const LINK_ORGANIZATION_JOB_TYPE = 'organization.link';

export type OrganizationJobSnapshot = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: unknown;
  errorCode: string | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export async function createLinkOrganizationJob(
  pool: Pool,
  userId: string,
  requestId: string,
  input: unknown,
): Promise<OrganizationJobSnapshot> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (
       user_id, type, status, idempotency_key, input_json,
       max_attempts, timeout_seconds
     ) VALUES ($1, $2, 'queued', $3, $4::jsonb, 2, 180)
     ON CONFLICT (user_id, idempotency_key)
     DO UPDATE SET updated_at = jobs.updated_at
     RETURNING id`,
    [
      userId,
      LINK_ORGANIZATION_JOB_TYPE,
      `organization.link:${requestId}`,
      JSON.stringify(input),
    ],
  );
  return requiredSnapshot(
    await getLinkOrganizationJob(pool, userId, result.rows[0]!.id),
  );
}

export async function getLinkOrganizationJob(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<OrganizationJobSnapshot | null> {
  const result = await pool.query<{
    id: string;
    status: OrganizationJobSnapshot['status'];
    result_json: unknown;
    error_code: string | null;
    attempt_count: number;
    max_attempts: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, status, result_json, error_code, attempt_count, max_attempts,
            created_at, updated_at
     FROM jobs
     WHERE user_id = $1 AND id = $2 AND type = $3`,
    [userId, jobId, LINK_ORGANIZATION_JOB_TYPE],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        result: row.result_json,
        errorCode: row.error_code,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }
    : null;
}

export function createLinkOrganizationHandler(
  pool: Pool,
  cipher: CredentialCipher,
  managed?: {
    priceCatalog: ManagedTextPriceCatalog;
    credentials: ManagedProviderCredentials;
  },
): JobHandler {
  return async (job: ClaimedJob, signal: AbortSignal) => {
    const account = await pool.query<{ ai_mode: string }>(
      `SELECT ai_mode FROM users WHERE id = $1`,
      [job.userId],
    );
    if (account.rows[0]?.ai_mode !== 'managed') {
      return organizeLink(pool, cipher, job.userId, job.input, signal);
    }
    if (!managed) throw new Error('managed_service_unavailable');
    return runManagedOrganization({
      pool,
      userId: job.userId,
      operation: 'link-organize',
      body: job.input,
      priceCatalog: managed.priceCatalog,
      managedCredentials: managed.credentials,
      run: (execution) =>
        organizeLink(
          pool,
          cipher,
          job.userId,
          job.input,
          signal,
          execution,
        ),
    });
  };
}

function requiredSnapshot(
  value: OrganizationJobSnapshot | null,
): OrganizationJobSnapshot {
  if (!value) throw new Error('organization_job_not_saved');
  return value;
}

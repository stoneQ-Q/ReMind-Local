import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { releaseJobCost, settleJobCost } from './billing.js';
import {
  createManagedJobQuote,
  type ManagedJobQuote,
} from './job-quotes.js';
import type { JobHandler, JobHandlers } from './jobs.js';
import {
  requestJobCancellation,
  type JobSnapshot,
} from './jobs.js';
import {
  estimateManagedImageCost,
  estimateManagedTextCost,
  estimateManagedTranscriptionCost,
  type ManagedMediaPriceCatalog,
} from './media-pricing.js';
import { assertProviderAvailable } from './provider-health.js';
import {
  getUserObjectFileMetadata,
  materializeUserObjectFile,
  readUserObjectFile,
  saveObjectFile,
} from './object-files.js';
import type { ObjectStore } from './object-store.js';
import {
  extractVideoAudioSegments,
  formatMediaTimestamp,
  probeMediaDurationSeconds,
  type ExtractedAudioSegment,
} from './video-audio-segments.js';

type MediaKind = 'image' | 'audio' | 'video';
type MediaStage =
  | 'image_analyze'
  | 'audio_transcribe'
  | 'video_prepare'
  | 'video_transcribe'
  | 'video_analyze';
type MediaStatus =
  | 'awaiting_confirmation'
  | 'pending'
  | 'processing'
  | 'settling'
  | 'releasing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
type MediaExecutionMode = 'bring_your_own_key' | 'managed';

type MediaRequestRow = {
  id: string;
  user_id: string;
  source_file_id: string;
  media_kind: MediaKind;
  status: MediaStatus;
  execution_mode: MediaExecutionMode;
  stage: MediaStage;
  generation: string;
  current_job_id: string | null;
  intermediate_file_id: string | null;
  transcript: string | null;
  result_json: unknown;
  error_code: string | null;
  billing_job_id: string | null;
  duration_seconds: number | null;
  estimated_cost_micros: string;
  actual_cost_micros: string;
  terminal_status: 'failed' | 'cancelled' | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type MediaRequestSnapshot = {
  id: string;
  sourceFileId: string;
  mediaKind: MediaKind;
  status: MediaStatus;
  executionMode: MediaExecutionMode;
  stage: MediaStage;
  currentJobId: string | null;
  intermediateFileId: string | null;
  transcript: string | null;
  result: unknown;
  errorCode: string | null;
  billingJobId: string | null;
  durationSeconds: number | null;
  estimatedCostMicros: string;
  actualCostMicros: string;
  createdAt: string;
  updatedAt: string;
};

export class MediaRequestError extends Error {
  constructor(
    readonly code:
      | 'byok_mode_required'
      | 'managed_mode_required'
      | 'media_provider_credential_required'
      | 'media_source_not_found'
      | 'media_idempotency_conflict'
      | 'invalid_media_duration',
  ) {
    super(code);
  }
}

export type ManagedMediaRequestQuote = {
  request: MediaRequestSnapshot;
  quote: ManagedJobQuote;
};

export type MediaTaskSnapshot = {
  request: MediaRequestSnapshot;
  quote: ManagedJobQuote | null;
  currentJob: JobSnapshot | null;
};

export interface MediaProcessingProvider {
  readonly requiresTrustedDuration?: boolean;
  prepareVideo(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<MediaProviderStageResult<ExtractedAudioSegment[]>>;
  transcribeAudio(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType?: string,
  ): Promise<MediaProviderStageResult<string>>;
  analyzeImage(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType?: string,
  ): Promise<
    MediaProviderStageResult<{ description: string; tags: string[] }>
  >;
  analyzeVideoTranscript(
    transcript: string,
    signal: AbortSignal,
    context?: MediaProviderContext,
  ): Promise<
    MediaProviderStageResult<{ summary: string; highlights: string[] }>
  >;
}

export type MediaProviderStageResult<T> = {
  output: T;
  actualCostMicros: bigint;
};

export type MediaProviderContext = {
  userId: string;
  reservedCostMicros: bigint;
  durationSeconds: number | null;
};

export class MockMediaProcessingProvider implements MediaProcessingProvider {
  async prepareVideo(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<MediaProviderStageResult<ExtractedAudioSegment[]>> {
    throwIfAborted(signal);
    return {
      output: [
        {
          sequenceNumber: 0,
          startSeconds: 0,
          content: Buffer.from(
            `mock-audio:${shortDigest(Buffer.from(sourcePath))}`,
          ),
        },
        {
          sequenceNumber: 1,
          startSeconds: 28,
          content: Buffer.from(
            `mock-audio-2:${shortDigest(Buffer.from(sourcePath))}`,
          ),
        },
      ],
      actualCostMicros: 0n,
    };
  }

  async transcribeAudio(
    content: Buffer,
    signal: AbortSignal,
  ): Promise<MediaProviderStageResult<string>> {
    throwIfAborted(signal);
    return {
      output: `模拟转写 ${shortDigest(content)}`,
      actualCostMicros: 0n,
    };
  }

  async analyzeImage(
    content: Buffer,
    signal: AbortSignal,
  ): Promise<
    MediaProviderStageResult<{ description: string; tags: string[] }>
  > {
    throwIfAborted(signal);
    return {
      output: {
        description: `模拟图片分析 ${shortDigest(content)}`,
        tags: ['模拟', '图片'],
      },
      actualCostMicros: 0n,
    };
  }

  async analyzeVideoTranscript(
    transcript: string,
    signal: AbortSignal,
  ): Promise<
    MediaProviderStageResult<{ summary: string; highlights: string[] }>
  > {
    throwIfAborted(signal);
    return {
      output: {
        summary: `模拟视频总结：${transcript}`,
        highlights: ['已完成临时音轨处理', '已完成分步转写'],
      },
      actualCostMicros: 0n,
    };
  }
}

export class FfmpegMediaProcessingProvider extends MockMediaProcessingProvider {
  override prepareVideo(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<MediaProviderStageResult<ExtractedAudioSegment[]>> {
    return extractVideoAudioSegments(sourcePath, signal).then((output) => ({
      output,
      actualCostMicros: 0n,
    }));
  }
}

export async function createMediaProcessingRequest(
  pool: Pool,
  input: {
    userId: string;
    sourceFileId: string;
    idempotencyKey: string;
  },
): Promise<MediaRequestSnapshot> {
  requireUuid(input.userId);
  requireUuid(input.sourceFileId);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const source = await pool.query<{ media_kind: string }>(
    `SELECT media_kind
     FROM files
     WHERE user_id = $1 AND id = $2
       AND purpose = 'source'
       AND status = 'ready'
       AND deleted_at IS NULL`,
    [input.userId, input.sourceFileId],
  );
  const mediaKind = source.rows[0]?.media_kind;
  if (!isMediaKind(mediaKind)) {
    const mode = await pool.query<{ ai_mode: string }>(
      'SELECT ai_mode FROM users WHERE id = $1',
      [input.userId],
    );
    if (mode.rows[0]?.ai_mode !== 'managed') {
      throw new MediaRequestError('managed_mode_required');
    }
    throw new MediaRequestError('media_source_not_found');
  }
  const stage = initialStage(mediaKind);
  await pool.query(
    `INSERT INTO media_processing_requests (
       user_id, idempotency_key, source_file_id, media_kind, stage
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [input.userId, idempotencyKey, input.sourceFileId, mediaKind, stage],
  );
  const existing = await pool.query<MediaRequestRow>(
    `SELECT *
     FROM media_processing_requests
     WHERE user_id = $1 AND idempotency_key = $2`,
    [input.userId, idempotencyKey],
  );
  const row = requiredRow(existing.rows[0]);
  if (row.source_file_id !== input.sourceFileId) {
    throw new Error('media_idempotency_conflict');
  }
  return mediaSnapshot(row);
}

export async function createByokMediaProcessingRequest(
  pool: Pool,
  input: {
    userId: string;
    sourceFileId: string;
    idempotencyKey: string;
  },
): Promise<MediaRequestSnapshot> {
  const source = await pool.query<{ media_kind: string }>(
    `SELECT file.media_kind
     FROM users AS owner
     JOIN files AS file ON file.user_id = owner.id
     WHERE owner.id = $1
       AND owner.status = 'active'
       AND owner.ai_mode = 'bring_your_own_key'
       AND file.id = $2
       AND file.purpose = 'source'
       AND file.status = 'ready'
       AND file.deleted_at IS NULL`,
    [input.userId, input.sourceFileId],
  );
  const mediaKind = source.rows[0]?.media_kind;
  if (!isMediaKind(mediaKind)) {
    const mode = await pool.query<{ ai_mode: string }>(
      'SELECT ai_mode FROM users WHERE id = $1',
      [input.userId],
    );
    if (mode.rows[0]?.ai_mode !== 'bring_your_own_key') {
      throw new MediaRequestError('byok_mode_required');
    }
    throw new MediaRequestError('media_source_not_found');
  }
  const requiredProviders =
    mediaKind === 'video' ? ['zhipu', 'deepseek'] : ['zhipu'];
  const credentials = await pool.query<{ provider: string }>(
    `SELECT provider
     FROM api_credentials
     WHERE user_id = $1
       AND provider = ANY($2::text[])
       AND revoked_at IS NULL`,
    [input.userId, requiredProviders],
  );
  if (
    new Set(credentials.rows.map((row) => row.provider)).size !==
    requiredProviders.length
  ) {
    throw new MediaRequestError('media_provider_credential_required');
  }
  try {
    return await createMediaProcessingRequest(pool, input);
  } catch (error) {
    if (error instanceof Error && error.message === 'media_source_not_found') {
      throw new MediaRequestError('media_source_not_found');
    }
    if (
      error instanceof Error &&
      error.message === 'media_idempotency_conflict'
    ) {
      throw new MediaRequestError('media_idempotency_conflict');
    }
    throw error;
  }
}

export async function createManagedMediaProcessingRequest(
  pool: Pool,
  input: {
    userId: string;
    sourceFileId: string;
    idempotencyKey: string;
    durationSeconds?: number;
  },
  catalog: ManagedMediaPriceCatalog,
): Promise<ManagedMediaRequestQuote> {
  requireUuid(input.userId);
  requireUuid(input.sourceFileId);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const source = await pool.query<{ media_kind: string }>(
    `SELECT file.media_kind
     FROM users AS owner
     JOIN files AS file ON file.user_id = owner.id
     WHERE owner.id = $1
       AND owner.status = 'active'
       AND owner.ai_mode = 'managed'
       AND file.id = $2
       AND file.purpose = 'source'
       AND file.status = 'ready'
       AND file.deleted_at IS NULL`,
    [input.userId, input.sourceFileId],
  );
  const mediaKind = source.rows[0]?.media_kind;
  if (!isMediaKind(mediaKind)) throw new Error('media_source_not_found');
  const durationSeconds =
    mediaKind === 'image'
      ? null
      : requireDurationSeconds(input.durationSeconds);
  if (mediaKind === 'video') {
    const client = await pool.connect();
    try {
      await assertProviderAvailable(client, 'deepseek');
    } finally {
      client.release();
    }
  }
  const estimateMicros = managedMediaEstimate(
    catalog,
    mediaKind,
    durationSeconds,
  );
  const stage = initialStage(mediaKind);
  await pool.query(
    `INSERT INTO media_processing_requests (
       user_id, idempotency_key, source_file_id, media_kind, status, stage,
       execution_mode, duration_seconds, estimated_cost_micros
     ) VALUES ($1, $2, $3, $4, 'awaiting_confirmation', $5,
               'managed', $6, $7)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [
      input.userId,
      idempotencyKey,
      input.sourceFileId,
      mediaKind,
      stage,
      durationSeconds,
      estimateMicros.toString(),
    ],
  );
  let request = requiredRow(
    (
      await pool.query<MediaRequestRow>(
        `SELECT * FROM media_processing_requests
         WHERE user_id = $1 AND idempotency_key = $2`,
        [input.userId, idempotencyKey],
      )
    ).rows[0],
  );
  if (
    request.execution_mode !== 'managed' ||
    request.source_file_id !== input.sourceFileId ||
    request.duration_seconds !== durationSeconds ||
    BigInt(request.estimated_cost_micros) !== estimateMicros
  ) {
    throw new MediaRequestError('media_idempotency_conflict');
  }
  const quote = await createManagedJobQuote(
    pool,
    input.userId,
    'media.pipeline',
    'zhipu',
    estimateMicros,
    `media-envelope:${request.id}`,
    { requestId: request.id },
  );
  if (request.billing_job_id && request.billing_job_id !== quote.jobId) {
    throw new MediaRequestError('media_idempotency_conflict');
  }
  await pool.query(
    `UPDATE media_processing_requests
     SET billing_job_id = $1, updated_at = now()
     WHERE user_id = $2 AND id = $3 AND billing_job_id IS NULL`,
    [quote.jobId, input.userId, request.id],
  );
  request = requiredRow(
    (
      await pool.query<MediaRequestRow>(
        `SELECT * FROM media_processing_requests
         WHERE user_id = $1 AND id = $2`,
        [input.userId, request.id],
      )
    ).rows[0],
  );
  return { request: mediaSnapshot(request), quote };
}

export async function getUserMediaProcessingRequest(
  pool: Pool,
  userId: string,
  requestId: string,
): Promise<MediaRequestSnapshot | null> {
  const result = await pool.query<MediaRequestRow>(
    `SELECT *
     FROM media_processing_requests
     WHERE user_id = $1 AND id = $2`,
    [userId, requestId],
  );
  return result.rows[0] ? mediaSnapshot(result.rows[0]) : null;
}

export async function listUserMediaProcessingRequests(
  pool: Pool,
  userId: string,
  limit = 50,
): Promise<MediaTaskSnapshot[]> {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const result = await pool.query<
    MediaRequestRow & {
      quote_type: string | null;
      quote_provider: string | null;
      quote_status: ManagedJobQuote['status'] | null;
      quote_estimated_cost_micros: string | null;
      quote_confirmation_required: boolean | null;
      quote_confirmed_at: Date | null;
      quote_expires_at: Date | null;
      current_job_type: string | null;
      current_job_status: JobSnapshot['status'] | null;
      current_job_attempt_count: number | null;
      current_job_max_attempts: number | null;
      current_job_timeout_seconds: number | null;
      current_job_cancel_requested_at: Date | null;
      current_job_created_at: Date | null;
      current_job_updated_at: Date | null;
    }
  >(
    `SELECT request.*,
            envelope.type AS quote_type,
            envelope.provider AS quote_provider,
            envelope.status AS quote_status,
            envelope.estimated_cost_micros AS quote_estimated_cost_micros,
            envelope.confirmation_required AS quote_confirmation_required,
            envelope.confirmed_at AS quote_confirmed_at,
            envelope.quote_expires_at AS quote_expires_at,
            current_job.type AS current_job_type,
            current_job.status AS current_job_status,
            current_job.attempt_count AS current_job_attempt_count,
            current_job.max_attempts AS current_job_max_attempts,
            current_job.timeout_seconds AS current_job_timeout_seconds,
            current_job.cancel_requested_at AS current_job_cancel_requested_at,
            current_job.created_at AS current_job_created_at,
            current_job.updated_at AS current_job_updated_at
     FROM media_processing_requests AS request
     LEFT JOIN jobs AS envelope
       ON envelope.user_id = request.user_id
      AND envelope.id = request.billing_job_id
     LEFT JOIN jobs AS current_job
       ON current_job.user_id = request.user_id
      AND current_job.id = request.current_job_id
     WHERE request.user_id = $1
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT $2`,
    [userId, boundedLimit],
  );
  return result.rows.map((row) => ({
    request: mediaSnapshot(row),
    currentJob:
      row.current_job_id &&
      row.current_job_type &&
      row.current_job_status &&
      row.current_job_attempt_count !== null &&
      row.current_job_max_attempts !== null &&
      row.current_job_timeout_seconds !== null &&
      row.current_job_created_at &&
      row.current_job_updated_at
        ? {
            id: row.current_job_id,
            type: row.current_job_type,
            status: row.current_job_status,
            attemptCount: row.current_job_attempt_count,
            maxAttempts: row.current_job_max_attempts,
            timeoutSeconds: row.current_job_timeout_seconds,
            cancelRequestedAt:
              row.current_job_cancel_requested_at?.toISOString() ?? null,
            createdAt: row.current_job_created_at.toISOString(),
            updatedAt: row.current_job_updated_at.toISOString(),
          }
        : null,
    quote:
      row.billing_job_id &&
      row.quote_type &&
      row.quote_provider &&
      row.quote_status &&
      row.quote_estimated_cost_micros !== null &&
      row.quote_confirmation_required !== null &&
      row.quote_expires_at
        ? {
            jobId: row.billing_job_id,
            type: row.quote_type,
            provider: row.quote_provider,
            status: row.quote_status,
            estimatedCostMicros: row.quote_estimated_cost_micros,
            confirmationRequired: row.quote_confirmation_required,
            confirmedAt: row.quote_confirmed_at?.toISOString() ?? null,
            expiresAt: row.quote_expires_at.toISOString(),
          }
        : null,
  }));
}

export async function requestMediaProcessingCancellation(
  pool: Pool,
  userId: string,
  requestId: string,
): Promise<MediaRequestSnapshot | null> {
  const result = await pool.query<{
    current_job_id: string | null;
    billing_job_id: string | null;
  }>(
    `UPDATE media_processing_requests AS request
     SET cancel_requested_at = COALESCE(request.cancel_requested_at, now()),
         status = CASE
           WHEN request.execution_mode = 'managed'
             AND envelope.status IN ('reserved', 'running')
             AND request.current_job_id IS NULL
           THEN 'releasing'
           WHEN request.current_job_id IS NULL THEN 'cancelled'
           ELSE request.status
         END,
         terminal_status = CASE
           WHEN request.execution_mode = 'managed' THEN 'cancelled'
           ELSE request.terminal_status
         END,
         finished_at = CASE
           WHEN request.current_job_id IS NULL
             AND NOT (
               request.execution_mode = 'managed'
               AND envelope.status IN ('reserved', 'running')
             )
           THEN now()
           ELSE request.finished_at
         END,
         updated_at = now()
     FROM jobs AS envelope
     WHERE request.user_id = $1 AND request.id = $2
       AND request.billing_job_id = envelope.id
       AND request.status IN (
         'awaiting_confirmation', 'pending', 'processing'
       )
     RETURNING request.current_job_id, request.billing_job_id`,
    [userId, requestId],
  );
  let row = result.rows[0];
  if (!row) {
    const byok = await pool.query<{
      current_job_id: string | null;
      billing_job_id: string | null;
    }>(
      `UPDATE media_processing_requests
       SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
           status = CASE WHEN current_job_id IS NULL THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN current_job_id IS NULL THEN now() ELSE finished_at END,
           updated_at = now()
       WHERE user_id = $1 AND id = $2
         AND execution_mode = 'bring_your_own_key'
         AND status IN ('pending', 'processing')
       RETURNING current_job_id, billing_job_id`,
      [userId, requestId],
    );
    row = byok.rows[0];
  }
  if (row?.current_job_id) {
    await requestJobCancellation(pool, userId, row.current_job_id);
  } else if (row?.billing_job_id) {
    await requestJobCancellation(pool, userId, row.billing_job_id);
  }
  return getUserMediaProcessingRequest(pool, userId, requestId);
}

export async function ensureNextMediaProcessingJob(
  pool: Pool,
): Promise<string | null> {
  const finalized = await finalizeNextMediaEnvelope(pool);
  if (finalized) return finalized;
  const reconciled = await reconcileNextMediaJob(pool);
  if (reconciled) return reconciled;
  await promoteNextManagedMediaRequest(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query<MediaRequestRow>(
      `SELECT *
       FROM media_processing_requests
       WHERE status IN ('pending', 'processing')
         AND current_job_id IS NULL
         AND cancel_requested_at IS NULL
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const request = candidate.rows[0];
    if (!request) {
      await client.query('COMMIT');
      return null;
    }
    const jobType = jobTypeForStage(request.stage, request.execution_mode);
    const job = await client.query<{ id: string }>(
      `INSERT INTO jobs (
         user_id, type, idempotency_key, input_json,
         confirmed_at, max_attempts, timeout_seconds
       ) VALUES (
         $1, $2, $3, $4::jsonb,
         CASE WHEN $5 THEN now() ELSE NULL END,
         3, $6
       )
       RETURNING id`,
      [
        request.user_id,
        jobType,
        `media:${request.id}:${request.generation}:${request.stage}`,
        JSON.stringify({
          requestId: request.id,
          generation: request.generation,
          stage: request.stage,
        }),
        jobType.startsWith('ai.'),
        timeoutForStage(request.stage),
      ],
    );
    const jobId = requiredRow(job.rows[0]).id;
    await client.query(
      `UPDATE media_processing_requests
       SET status = 'processing',
           current_job_id = $1,
           error_code = NULL,
           updated_at = now()
       WHERE user_id = $2 AND id = $3`,
      [jobId, request.user_id, request.id],
    );
    await client.query('COMMIT');
    return jobId;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function promoteNextManagedMediaRequest(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE media_processing_requests AS request
     SET status = 'pending', updated_at = now()
     FROM jobs AS envelope
     WHERE request.execution_mode = 'managed'
       AND request.status = 'awaiting_confirmation'
       AND request.billing_job_id = envelope.id
       AND envelope.user_id = request.user_id
       AND envelope.status = 'reserved'
       AND envelope.reserved_cost_micros = request.estimated_cost_micros
       AND envelope.reserved_cost_micros > 0
       AND request.id = (
         SELECT candidate.id
         FROM media_processing_requests AS candidate
         JOIN jobs AS candidate_envelope
           ON candidate_envelope.user_id = candidate.user_id
          AND candidate_envelope.id = candidate.billing_job_id
         WHERE candidate.execution_mode = 'managed'
           AND candidate.status = 'awaiting_confirmation'
           AND candidate.cancel_requested_at IS NULL
           AND candidate_envelope.status = 'reserved'
           AND candidate_envelope.reserved_cost_micros =
               candidate.estimated_cost_micros
         ORDER BY candidate.created_at, candidate.id
         LIMIT 1
       )`,
  );
}

async function finalizeNextMediaEnvelope(
  pool: Pool,
): Promise<string | null> {
  const result = await pool.query<{
    id: string;
    user_id: string;
    status: 'settling' | 'releasing';
    billing_job_id: string;
    actual_cost_micros: string;
    terminal_status: 'failed' | 'cancelled' | null;
    envelope_status: string;
  }>(
    `SELECT request.id, request.user_id, request.status,
            request.billing_job_id, request.actual_cost_micros,
            request.terminal_status, envelope.status AS envelope_status
     FROM media_processing_requests AS request
     JOIN jobs AS envelope
       ON envelope.user_id = request.user_id
      AND envelope.id = request.billing_job_id
     WHERE request.execution_mode = 'managed'
       AND request.status IN ('settling', 'releasing')
     ORDER BY request.created_at, request.id
     LIMIT 1`,
  );
  const request = result.rows[0];
  if (!request) return null;
  if (request.status === 'settling') {
    if (request.envelope_status !== 'succeeded') {
      await settleJobCost(
        pool,
        request.user_id,
        request.billing_job_id,
        BigInt(request.actual_cost_micros),
        `media-envelope:${request.id}`,
      );
    }
    await pool.query(
      `UPDATE media_processing_requests
       SET status = 'succeeded', finished_at = now(), updated_at = now()
       WHERE user_id = $1 AND id = $2 AND status = 'settling'`,
      [request.user_id, request.id],
    );
  } else {
    const terminalStatus = request.terminal_status ?? 'failed';
    if (
      request.envelope_status !== 'failed' &&
      request.envelope_status !== 'cancelled'
    ) {
      await releaseJobCost(
        pool,
        request.user_id,
        request.billing_job_id,
        terminalStatus,
        `media-envelope:${request.id}`,
      );
    }
    await pool.query(
      `UPDATE media_processing_requests
       SET status = $1, finished_at = now(), updated_at = now()
       WHERE user_id = $2 AND id = $3 AND status = 'releasing'`,
      [terminalStatus, request.user_id, request.id],
    );
  }
  return `finalized:${request.id}:${request.status}`;
}

export function createMediaProcessingHandlers(
  pool: Pool,
  store: ObjectStore,
  provider: MediaProcessingProvider = new MockMediaProcessingProvider(),
  options: {
    stageCostMicros?: (
      stage: MediaStage,
      result: unknown,
      request: MediaRequestSnapshot,
    ) => bigint;
  } = {},
): JobHandlers {
  const handler = createMediaHandler(pool, store, provider, options);
  return new Map([
    ['media.video.prepare', handler],
    ['ai.image', handler],
    ['ai.transcription', handler],
    ['ai.text', handler],
    ['media.image.analyze', handler],
    ['media.audio.transcribe', handler],
    ['media.video.transcribe', handler],
    ['media.video.analyze', handler],
  ]);
}

function createMediaHandler(
  pool: Pool,
  store: ObjectStore,
  provider: MediaProcessingProvider,
  options: {
    stageCostMicros?: (
      stage: MediaStage,
      result: unknown,
      request: MediaRequestSnapshot,
    ) => bigint;
  },
): JobHandler {
  return async (job, signal) => {
    const input = parseMediaJobInput(job.input);
    const request = await loadActiveRequest(
      pool,
      job.userId,
      job.id,
      input,
    );
    if (request.stage === 'image_analyze') {
      const metadata = await requiredFileMetadata(
        pool,
        job.userId,
        request.source_file_id,
      );
      const content = await readUserObjectFile(
        pool,
        store,
        job.userId,
        request.source_file_id,
      );
      const analyzed = await provider.analyzeImage(
        content,
        signal,
        providerContext(job, request),
        metadata.contentType,
      );
      return withStageCost(
        sanitizeImageResult(analyzed.output),
        analyzed.actualCostMicros,
        request,
        options,
      );
    }
    if (request.stage === 'video_prepare') {
      const directory = await mkdtemp(join(tmpdir(), 'remind-video-source-'));
      try {
        const sourcePath = join(directory, 'source-video');
        await materializeUserObjectFile(
          pool,
          store,
          job.userId,
          request.source_file_id,
          sourcePath,
        );
        if (
          request.execution_mode === 'managed' &&
          provider.requiresTrustedDuration
        ) {
          const measuredDuration = await probeMediaDurationSeconds(
            sourcePath,
            signal,
          );
          await saveTrustedDuration(pool, request, measuredDuration);
        }
        const prepared = await provider.prepareVideo(sourcePath, signal);
        const segmentFileIds: string[] = [];
        for (const segment of prepared.output) {
          throwIfAborted(signal);
          const temporary = await saveObjectFile(pool, store, {
            userId: job.userId,
            contentType: 'audio/mpeg',
            content: segment.content,
            purpose: 'temporary',
            originalName: `video-audio-${segment.sequenceNumber}.mp3`,
            temporaryTtlSeconds: 300,
          });
          segmentFileIds.push(temporary.id);
        }
        return withStageCost(
          { segmentFileIds },
          prepared.actualCostMicros,
          request,
          options,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (
      request.stage === 'audio_transcribe' ||
      request.stage === 'video_transcribe'
    ) {
      if (request.stage === 'audio_transcribe') {
        let trustedDuration = request.duration_seconds;
        if (
          request.execution_mode === 'managed' &&
          provider.requiresTrustedDuration
        ) {
          const directory = await mkdtemp(
            join(tmpdir(), 'remind-audio-source-'),
          );
          try {
            const sourcePath = join(directory, 'source-audio');
            await materializeUserObjectFile(
              pool,
              store,
              job.userId,
              request.source_file_id,
              sourcePath,
            );
            trustedDuration = await probeMediaDurationSeconds(
              sourcePath,
              signal,
            );
            await saveTrustedDuration(pool, request, trustedDuration);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
        const content = await readUserObjectFile(
          pool,
          store,
          job.userId,
          request.source_file_id,
        );
        const metadata = await requiredFileMetadata(
          pool,
          job.userId,
          request.source_file_id,
        );
        const transcription = await provider.transcribeAudio(
          content,
          signal,
          providerContext(job, request, trustedDuration),
          metadata.contentType,
        );
        return withStageCost(
          { transcript: sanitizeText(transcription.output, 100_000) },
          transcription.actualCostMicros,
          request,
          options,
        );
      }
      const segments = await loadVideoSegments(pool, request);
      const lines: string[] = [];
      let actualCostMicros = 0n;
      for (const segment of segments) {
        throwIfAborted(signal);
        const content = await readUserObjectFile(
          pool,
          store,
          job.userId,
          segment.file_id,
        );
        const transcription = await provider.transcribeAudio(
          content,
          signal,
          providerContext(
            job,
            request,
            segmentDurationSeconds(request, segment.start_seconds),
          ),
          'audio/mpeg',
        );
        actualCostMicros += transcription.actualCostMicros;
        const text = sanitizeText(transcription.output, 10_000);
        if (text) {
          lines.push(`[${formatMediaTimestamp(segment.start_seconds)}] ${text}`);
        }
      }
      if (!lines.length) throw new Error('media_transcript_empty');
      return withStageCost(
        { transcript: lines.join('\n').slice(0, 100_000) },
        actualCostMicros,
        request,
        options,
      );
    }
    if (request.stage === 'video_analyze') {
      const transcript = request.transcript;
      if (!transcript) throw new Error('media_transcript_missing');
      const analyzed = await provider.analyzeVideoTranscript(
        transcript,
        signal,
        providerContext(job, request),
      );
      return withStageCost(
        sanitizeVideoResult(analyzed.output),
        analyzed.actualCostMicros,
        request,
        options,
      );
    }
    throw new Error('unsupported_media_stage');
  };
}

async function reconcileNextMediaJob(pool: Pool): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<
      MediaRequestRow & {
        job_status: 'succeeded' | 'failed' | 'cancelled';
        job_result: unknown;
        job_error: string | null;
      }
    >(
      `SELECT request.*,
              job.status AS job_status,
              job.result_json AS job_result,
              job.error_code AS job_error
       FROM media_processing_requests AS request
       JOIN jobs AS job
         ON job.user_id = request.user_id
        AND job.id = request.current_job_id
       WHERE request.status = 'processing'
         AND job.status IN ('succeeded', 'failed', 'cancelled')
       ORDER BY request.created_at, request.id
       FOR UPDATE OF request SKIP LOCKED
       LIMIT 1`,
    );
    const request = result.rows[0];
    if (!request) {
      await client.query('COMMIT');
      return null;
    }
    if (request.job_status !== 'succeeded') {
      await finishMediaRequest(
        client,
        request,
        request.job_status,
        request.job_error ?? request.job_status,
      );
    } else {
      await applySuccessfulStage(client, request, request.job_result);
    }
    await client.query('COMMIT');
    return `reconciled:${request.id}:${request.stage}`;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function applySuccessfulStage(
  client: PoolClient,
  request: MediaRequestRow,
  result: unknown,
): Promise<void> {
  const stageCostMicros = objectCostMicros(result);
  const totalActualCostMicros =
    BigInt(request.actual_cost_micros) + stageCostMicros;
  if (totalActualCostMicros > BigInt(request.estimated_cost_micros)) {
    await finishMediaRequest(
      client,
      request,
      'failed',
      'actual_cost_exceeds_envelope',
    );
    return;
  }
  if (request.stage === 'video_prepare') {
    const segmentFileIds = objectStringArray(result, 'segmentFileIds', 800);
    if (!segmentFileIds.length) throw new Error('media_temporary_file_missing');
    for (let index = 0; index < segmentFileIds.length; index += 1) {
      const fileId = segmentFileIds[index] ?? '';
      requireUuid(fileId);
      const inserted = await client.query(
        `INSERT INTO media_processing_segments (
           user_id, request_id, sequence_number, start_seconds, file_id
         )
         SELECT $1, $2, $3, $4, file.id
         FROM files AS file
         WHERE file.user_id = $1 AND file.id = $5
           AND file.purpose = 'temporary' AND file.media_kind = 'audio'
           AND file.status = 'ready' AND file.deleted_at IS NULL
         ON CONFLICT (user_id, request_id, sequence_number) DO NOTHING`,
        [request.user_id, request.id, index, index * 28, fileId],
      );
      if (inserted.rowCount !== 1) throw new Error('media_temporary_file_missing');
    }
    await advanceStage(
      client,
      request,
      'video_transcribe',
      { intermediateFileId: segmentFileIds[0] },
      stageCostMicros,
    );
    return;
  }
  if (
    request.stage === 'audio_transcribe' ||
    request.stage === 'video_transcribe'
  ) {
    const transcript = sanitizeText(objectString(result, 'transcript'), 100_000);
    if (request.stage === 'audio_transcribe') {
      await succeedMediaRequest(
        client,
        request,
        transcript,
        { transcript },
        stageCostMicros,
      );
    } else {
      await expireIntermediateFile(client, request);
      await advanceStage(
        client,
        request,
        'video_analyze',
        { transcript },
        stageCostMicros,
      );
    }
    return;
  }
  if (request.stage === 'image_analyze') {
    const imageResult = sanitizeImageResult(result);
    await succeedMediaRequest(
      client,
      request,
      null,
      imageResult,
      stageCostMicros,
    );
    return;
  }
  if (request.stage === 'video_analyze') {
    const videoResult = sanitizeVideoResult(result);
    await succeedMediaRequest(
      client,
      request,
      request.transcript,
      {
        transcript: request.transcript,
        ...videoResult,
      },
      stageCostMicros,
    );
    return;
  }
  throw new Error('unsupported_media_stage');
}

async function advanceStage(
  client: PoolClient,
  request: MediaRequestRow,
  nextStage: MediaStage,
  values: { intermediateFileId?: string; transcript?: string },
  stageCostMicros: bigint,
): Promise<void> {
  await client.query(
    `UPDATE media_processing_requests
     SET stage = $1,
         current_job_id = NULL,
         intermediate_file_id = COALESCE($2, intermediate_file_id),
         transcript = COALESCE($3, transcript),
         actual_cost_micros = actual_cost_micros + $4,
         updated_at = now()
     WHERE user_id = $5 AND id = $6`,
    [
      nextStage,
      values.intermediateFileId ?? null,
      values.transcript ?? null,
      stageCostMicros.toString(),
      request.user_id,
      request.id,
    ],
  );
}

async function succeedMediaRequest(
  client: PoolClient,
  request: MediaRequestRow,
  transcript: string | null,
  result: unknown,
  stageCostMicros: bigint,
): Promise<void> {
  await client.query(
    `UPDATE media_processing_requests
     SET status = CASE
           WHEN execution_mode = 'managed' THEN 'settling'
           ELSE 'succeeded'
         END,
         transcript = $1,
         result_json = $2::jsonb,
         error_code = NULL,
         actual_cost_micros = actual_cost_micros + $3,
         finished_at = CASE
           WHEN execution_mode = 'managed' THEN NULL
           ELSE now()
         END,
         updated_at = now()
     WHERE user_id = $4 AND id = $5`,
    [
      transcript,
      JSON.stringify(result),
      stageCostMicros.toString(),
      request.user_id,
      request.id,
    ],
  );
}

async function finishMediaRequest(
  client: PoolClient,
  request: MediaRequestRow,
  status: 'failed' | 'cancelled',
  errorCode: string,
): Promise<void> {
  await expireIntermediateFile(client, request);
  await client.query(
    `UPDATE media_processing_requests
     SET status = CASE
           WHEN execution_mode = 'managed' THEN 'releasing'
           ELSE $1
         END,
         terminal_status = CASE
           WHEN execution_mode = 'managed' THEN $1
           ELSE terminal_status
         END,
         error_code = $2,
         finished_at = CASE
           WHEN execution_mode = 'managed' THEN NULL
           ELSE now()
         END,
         updated_at = now()
     WHERE user_id = $3 AND id = $4`,
    [status, normalizeErrorCode(errorCode), request.user_id, request.id],
  );
}

async function expireIntermediateFile(
  client: PoolClient,
  request: MediaRequestRow,
): Promise<void> {
  await client.query(
    `UPDATE files
     SET expires_at = LEAST(expires_at, now()), updated_at = now()
     WHERE user_id = $1
       AND id IN (
         SELECT file_id
         FROM media_processing_segments
         WHERE user_id = $1 AND request_id = $2
       )
       AND purpose = 'temporary' AND status = 'ready'`,
    [request.user_id, request.id],
  );
}

async function loadVideoSegments(
  pool: Pool,
  request: MediaRequestRow,
): Promise<Array<{ file_id: string; start_seconds: number }>> {
  const result = await pool.query<{ file_id: string; start_seconds: number }>(
    `SELECT file_id, start_seconds
     FROM media_processing_segments
     WHERE user_id = $1 AND request_id = $2
     ORDER BY sequence_number`,
    [request.user_id, request.id],
  );
  if (!result.rowCount) throw new Error('media_audio_missing');
  return result.rows;
}

async function loadActiveRequest(
  pool: Pool,
  userId: string,
  jobId: string,
  input: { requestId: string; generation: string; stage: MediaStage },
): Promise<MediaRequestRow> {
  const result = await pool.query<MediaRequestRow>(
    `SELECT request.*
     FROM media_processing_requests AS request
     JOIN users AS owner ON owner.id = request.user_id
     LEFT JOIN jobs AS envelope
       ON envelope.user_id = request.user_id
      AND envelope.id = request.billing_job_id
     WHERE request.user_id = $1 AND request.id = $2
       AND request.generation = $3
       AND request.stage = $4
       AND request.status = 'processing'
       AND request.current_job_id = $5
       AND request.cancel_requested_at IS NULL
       AND owner.status = 'active'
       AND (
         (
           request.execution_mode = 'bring_your_own_key'
           AND owner.ai_mode = 'bring_your_own_key'
           AND request.billing_job_id IS NULL
         )
         OR (
           request.execution_mode = 'managed'
           AND owner.ai_mode = 'managed'
           AND envelope.status = 'reserved'
           AND envelope.reserved_cost_micros =
               request.estimated_cost_micros
           AND envelope.reserved_cost_micros > 0
         )
       )`,
    [userId, input.requestId, input.generation, input.stage, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('media_job_superseded');
  return row;
}

function parseMediaJobInput(
  value: unknown,
): { requestId: string; generation: string; stage: MediaStage } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_media_job_input');
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.requestId !== 'string' ||
    typeof input.generation !== 'string' ||
    typeof input.stage !== 'string' ||
    !isMediaStage(input.stage)
  ) {
    throw new Error('invalid_media_job_input');
  }
  requireUuid(input.requestId);
  if (!/^[1-9][0-9]{0,18}$/.test(input.generation)) {
    throw new Error('invalid_media_job_input');
  }
  return {
    requestId: input.requestId,
    generation: input.generation,
    stage: input.stage,
  };
}

function sanitizeImageResult(
  value: unknown,
): { description: string; tags: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_image_analysis_result');
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.tags)) throw new Error('invalid_image_analysis_result');
  return {
    description: sanitizeText(result.description, 10_000),
    tags: result.tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => sanitizeText(tag, 80))
      .filter(Boolean)
      .slice(0, 20),
  };
}

function sanitizeVideoResult(
  value: unknown,
): { summary: string; highlights: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_video_analysis_result');
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.highlights)) {
    throw new Error('invalid_video_analysis_result');
  }
  return {
    summary: sanitizeText(result.summary, 20_000),
    highlights: result.highlights
      .filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeText(item, 500))
      .filter(Boolean)
      .slice(0, 50),
  };
}

function sanitizeText(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error('invalid_media_text');
  return value.replace(/\u0000/g, '').trim().slice(0, maximumLength);
}

function objectString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_media_job_result');
  }
  const property = (value as Record<string, unknown>)[key];
  if (typeof property !== 'string') throw new Error('invalid_media_job_result');
  return property;
}

function objectStringArray(
  value: unknown,
  key: string,
  maximumLength: number,
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_media_job_result');
  }
  const property = (value as Record<string, unknown>)[key];
  if (
    !Array.isArray(property) ||
    property.length > maximumLength ||
    !property.every((item) => typeof item === 'string')
  ) {
    throw new Error('invalid_media_job_result');
  }
  return property;
}

function initialStage(kind: MediaKind): MediaStage {
  if (kind === 'image') return 'image_analyze';
  if (kind === 'audio') return 'audio_transcribe';
  return 'video_prepare';
}

function jobTypeForStage(
  stage: MediaStage,
  executionMode: MediaExecutionMode,
): string {
  if (executionMode === 'managed') {
    if (stage === 'image_analyze') return 'media.image.analyze';
    if (stage === 'audio_transcribe') return 'media.audio.transcribe';
    if (stage === 'video_prepare') return 'media.video.prepare';
    if (stage === 'video_transcribe') return 'media.video.transcribe';
    return 'media.video.analyze';
  }
  if (stage === 'image_analyze') return 'ai.image';
  if (stage === 'video_prepare') return 'media.video.prepare';
  if (stage === 'video_analyze') return 'ai.text';
  return 'ai.transcription';
}

function timeoutForStage(stage: MediaStage): number {
  if (stage === 'video_prepare') return 600;
  if (stage === 'audio_transcribe' || stage === 'video_transcribe') return 900;
  return 120;
}

function isMediaKind(value: unknown): value is MediaKind {
  return value === 'image' || value === 'audio' || value === 'video';
}

function isMediaStage(value: string): value is MediaStage {
  return (
    value === 'image_analyze' ||
    value === 'audio_transcribe' ||
    value === 'video_prepare' ||
    value === 'video_transcribe' ||
    value === 'video_analyze'
  );
}

function requireIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error('invalid_idempotency_key');
  }
  return normalized;
}

function requireUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error('invalid_id');
  }
}

function shortDigest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function providerContext(
  job: Parameters<JobHandler>[0],
  request: MediaRequestRow,
  durationSeconds = request.duration_seconds,
): MediaProviderContext {
  return {
    userId: job.userId,
    reservedCostMicros:
      request.execution_mode === 'managed'
        ? BigInt(request.estimated_cost_micros) -
          BigInt(request.actual_cost_micros)
        : BigInt(job.reservedCostMicros),
    durationSeconds,
  };
}

function withStageCost(
  result: Record<string, unknown>,
  providerCostMicros: bigint,
  request: MediaRequestRow,
  options: {
    stageCostMicros?: (
      stage: MediaStage,
      result: unknown,
      request: MediaRequestSnapshot,
    ) => bigint;
  },
): Record<string, unknown> {
  const cost =
    request.execution_mode === 'managed'
        ? (options.stageCostMicros?.(
          request.stage,
          result,
          mediaSnapshot(request),
        ) ?? providerCostMicros)
      : 0n;
  if (cost < 0n) throw new Error('invalid_media_stage_cost');
  return { ...result, actualCostMicros: cost.toString() };
}

function segmentDurationSeconds(
  request: MediaRequestRow,
  startSeconds: number,
): number | null {
  if (request.duration_seconds === null) return null;
  return Math.max(1, Math.min(28, request.duration_seconds - startSeconds));
}

async function saveTrustedDuration(
  pool: Pool,
  request: MediaRequestRow,
  measuredDurationSeconds: number,
): Promise<void> {
  if (
    request.duration_seconds === null ||
    measuredDurationSeconds > request.duration_seconds
  ) {
    throw new Error('media_duration_exceeds_quote');
  }
  await pool.query(
    `UPDATE media_processing_requests
     SET duration_seconds = $1, updated_at = now()
     WHERE user_id = $2 AND id = $3
       AND execution_mode = 'managed'
       AND status = 'processing'`,
    [measuredDurationSeconds, request.user_id, request.id],
  );
}

function objectCostMicros(value: unknown): bigint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_media_job_result');
  }
  const cost = (value as Record<string, unknown>).actualCostMicros;
  if (cost === undefined) return 0n;
  if (typeof cost !== 'string' || !/^[0-9]{1,18}$/.test(cost)) {
    throw new Error('invalid_media_stage_cost');
  }
  return BigInt(cost);
}

function managedMediaEstimate(
  catalog: ManagedMediaPriceCatalog,
  mediaKind: MediaKind,
  durationSeconds: number | null,
): bigint {
  if (mediaKind === 'image') return estimateManagedImageCost(catalog);
  if (durationSeconds === null) throw new Error('invalid_media_duration');
  if (mediaKind === 'audio') {
    return estimateManagedTranscriptionCost(catalog, durationSeconds);
  }
  let transcription = 0n;
  for (let start = 0; start < durationSeconds; start += 28) {
    transcription += estimateManagedTranscriptionCost(
      catalog,
      Math.min(28, durationSeconds - start),
    );
  }
  return (
    transcription +
    estimateManagedTextCost(catalog, 120_000, 1_500)
  );
}

function requireDurationSeconds(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 1 || value > 21_600) {
    throw new MediaRequestError('invalid_media_duration');
  }
  return value;
}

async function requiredFileMetadata(
  pool: Pool,
  userId: string,
  fileId: string,
): Promise<{ contentType: string; mediaKind: MediaKind }> {
  const metadata = await getUserObjectFileMetadata(pool, userId, fileId);
  if (!metadata || !isMediaKind(metadata.mediaKind)) {
    throw new Error('media_source_not_found');
  }
  return { contentType: metadata.contentType, mediaKind: metadata.mediaKind };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function normalizeErrorCode(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'media_processing_failed';
}

function mediaSnapshot(row: MediaRequestRow): MediaRequestSnapshot {
  return {
    id: row.id,
    sourceFileId: row.source_file_id,
    mediaKind: row.media_kind,
    status: row.status,
    executionMode: row.execution_mode,
    stage: row.stage,
    currentJobId: row.current_job_id,
    intermediateFileId: row.intermediate_file_id,
    transcript: row.transcript,
    result: row.result_json,
    errorCode: row.error_code,
    billingJobId: row.billing_job_id,
    durationSeconds: row.duration_seconds,
    estimatedCostMicros: row.estimated_cost_micros,
    actualCostMicros: row.actual_cost_micros,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error.
  }
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

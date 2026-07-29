import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import type { JobHandler, JobHandlers } from './jobs.js';
import { requestJobCancellation } from './jobs.js';
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
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

type MediaRequestRow = {
  id: string;
  user_id: string;
  source_file_id: string;
  media_kind: MediaKind;
  status: MediaStatus;
  stage: MediaStage;
  generation: string;
  current_job_id: string | null;
  intermediate_file_id: string | null;
  transcript: string | null;
  result_json: unknown;
  error_code: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type MediaRequestSnapshot = {
  id: string;
  sourceFileId: string;
  mediaKind: MediaKind;
  status: MediaStatus;
  stage: MediaStage;
  currentJobId: string | null;
  intermediateFileId: string | null;
  transcript: string | null;
  result: unknown;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export class MediaRequestError extends Error {
  constructor(
    readonly code:
      | 'byok_mode_required'
      | 'media_provider_credential_required'
      | 'media_source_not_found'
      | 'media_idempotency_conflict',
  ) {
    super(code);
  }
}

export interface MediaProcessingProvider {
  prepareVideo(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ExtractedAudioSegment[]>;
  transcribeAudio(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType?: string,
  ): Promise<string>;
  analyzeImage(
    content: Buffer,
    signal: AbortSignal,
    context?: MediaProviderContext,
    contentType?: string,
  ): Promise<{ description: string; tags: string[] }>;
  analyzeVideoTranscript(
    transcript: string,
    signal: AbortSignal,
    context?: MediaProviderContext,
  ): Promise<{ summary: string; highlights: string[] }>;
}

export type MediaProviderContext = {
  userId: string;
  reservedCostMicros: bigint;
};

export class MockMediaProcessingProvider implements MediaProcessingProvider {
  async prepareVideo(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ExtractedAudioSegment[]> {
    throwIfAborted(signal);
    return [
      {
        sequenceNumber: 0,
        startSeconds: 0,
        content: Buffer.from(`mock-audio:${shortDigest(Buffer.from(sourcePath))}`),
      },
      {
        sequenceNumber: 1,
        startSeconds: 28,
        content: Buffer.from(
          `mock-audio-2:${shortDigest(Buffer.from(sourcePath))}`,
        ),
      },
    ];
  }

  async transcribeAudio(
    content: Buffer,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    return `模拟转写 ${shortDigest(content)}`;
  }

  async analyzeImage(
    content: Buffer,
    signal: AbortSignal,
  ): Promise<{ description: string; tags: string[] }> {
    throwIfAborted(signal);
    return {
      description: `模拟图片分析 ${shortDigest(content)}`,
      tags: ['模拟', '图片'],
    };
  }

  async analyzeVideoTranscript(
    transcript: string,
    signal: AbortSignal,
  ): Promise<{ summary: string; highlights: string[] }> {
    throwIfAborted(signal);
    return {
      summary: `模拟视频总结：${transcript}`,
      highlights: ['已完成临时音轨处理', '已完成分步转写'],
    };
  }
}

export class FfmpegMediaProcessingProvider extends MockMediaProcessingProvider {
  override prepareVideo(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ExtractedAudioSegment[]> {
    return extractVideoAudioSegments(sourcePath, signal);
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
  if (!isMediaKind(mediaKind)) throw new Error('media_source_not_found');
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

export async function requestMediaProcessingCancellation(
  pool: Pool,
  userId: string,
  requestId: string,
): Promise<MediaRequestSnapshot | null> {
  const result = await pool.query<{ current_job_id: string | null }>(
    `UPDATE media_processing_requests
     SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
         status = CASE
           WHEN current_job_id IS NULL THEN 'cancelled'
           ELSE status
         END,
         finished_at = CASE
           WHEN current_job_id IS NULL THEN now()
           ELSE finished_at
         END,
         updated_at = now()
     WHERE user_id = $1 AND id = $2
       AND status IN ('pending', 'processing')
     RETURNING current_job_id`,
    [userId, requestId],
  );
  const jobId = result.rows[0]?.current_job_id;
  if (jobId) await requestJobCancellation(pool, userId, jobId);
  return getUserMediaProcessingRequest(pool, userId, requestId);
}

export async function ensureNextMediaProcessingJob(
  pool: Pool,
): Promise<string | null> {
  const reconciled = await reconcileNextMediaJob(pool);
  if (reconciled) return reconciled;

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
    const jobType = jobTypeForStage(request.stage);
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

export function createMediaProcessingHandlers(
  pool: Pool,
  store: ObjectStore,
  provider: MediaProcessingProvider = new MockMediaProcessingProvider(),
): JobHandlers {
  const handler = createMediaHandler(pool, store, provider);
  return new Map([
    ['media.video.prepare', handler],
    ['ai.image', handler],
    ['ai.transcription', handler],
    ['ai.text', handler],
  ]);
}

function createMediaHandler(
  pool: Pool,
  store: ObjectStore,
  provider: MediaProcessingProvider,
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
      return sanitizeImageResult(
        await provider.analyzeImage(
          content,
          signal,
          providerContext(job),
          metadata.contentType,
        ),
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
        const prepared = await provider.prepareVideo(sourcePath, signal);
        const segmentFileIds: string[] = [];
        for (const segment of prepared) {
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
        return { segmentFileIds };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (
      request.stage === 'audio_transcribe' ||
      request.stage === 'video_transcribe'
    ) {
      if (request.stage === 'audio_transcribe') {
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
        const transcript = await provider.transcribeAudio(
          content,
          signal,
          providerContext(job),
          metadata.contentType,
        );
        return { transcript: sanitizeText(transcript, 100_000) };
      }
      const segments = await loadVideoSegments(pool, request);
      const lines: string[] = [];
      for (const segment of segments) {
        throwIfAborted(signal);
        const content = await readUserObjectFile(
          pool,
          store,
          job.userId,
          segment.file_id,
        );
        const text = sanitizeText(
          await provider.transcribeAudio(
            content,
            signal,
            providerContext(job),
            'audio/mpeg',
          ),
          10_000,
        );
        if (text) {
          lines.push(`[${formatMediaTimestamp(segment.start_seconds)}] ${text}`);
        }
      }
      if (!lines.length) throw new Error('media_transcript_empty');
      return { transcript: lines.join('\n').slice(0, 100_000) };
    }
    if (request.stage === 'video_analyze') {
      const transcript = request.transcript;
      if (!transcript) throw new Error('media_transcript_missing');
      return sanitizeVideoResult(
        await provider.analyzeVideoTranscript(
          transcript,
          signal,
          providerContext(job),
        ),
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
    await advanceStage(client, request, 'video_transcribe', {
      intermediateFileId: segmentFileIds[0],
    });
    return;
  }
  if (
    request.stage === 'audio_transcribe' ||
    request.stage === 'video_transcribe'
  ) {
    const transcript = sanitizeText(objectString(result, 'transcript'), 100_000);
    if (request.stage === 'audio_transcribe') {
      await succeedMediaRequest(client, request, transcript, { transcript });
    } else {
      await expireIntermediateFile(client, request);
      await advanceStage(client, request, 'video_analyze', { transcript });
    }
    return;
  }
  if (request.stage === 'image_analyze') {
    const imageResult = sanitizeImageResult(result);
    await succeedMediaRequest(client, request, null, imageResult);
    return;
  }
  if (request.stage === 'video_analyze') {
    const videoResult = sanitizeVideoResult(result);
    await succeedMediaRequest(client, request, request.transcript, {
      transcript: request.transcript,
      ...videoResult,
    });
    return;
  }
  throw new Error('unsupported_media_stage');
}

async function advanceStage(
  client: PoolClient,
  request: MediaRequestRow,
  nextStage: MediaStage,
  values: { intermediateFileId?: string; transcript?: string },
): Promise<void> {
  await client.query(
    `UPDATE media_processing_requests
     SET stage = $1,
         current_job_id = NULL,
         intermediate_file_id = COALESCE($2, intermediate_file_id),
         transcript = COALESCE($3, transcript),
         updated_at = now()
     WHERE user_id = $4 AND id = $5`,
    [
      nextStage,
      values.intermediateFileId ?? null,
      values.transcript ?? null,
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
): Promise<void> {
  await client.query(
    `UPDATE media_processing_requests
     SET status = 'succeeded',
         transcript = $1,
         result_json = $2::jsonb,
         error_code = NULL,
         finished_at = now(),
         updated_at = now()
     WHERE user_id = $3 AND id = $4`,
    [transcript, JSON.stringify(result), request.user_id, request.id],
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
     SET status = $1,
         error_code = $2,
         finished_at = now(),
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
    `SELECT *
     FROM media_processing_requests
     WHERE user_id = $1 AND id = $2
       AND generation = $3
       AND stage = $4
       AND status = 'processing'
       AND current_job_id = $5
       AND cancel_requested_at IS NULL`,
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

function jobTypeForStage(stage: MediaStage): string {
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

function providerContext(job: Parameters<JobHandler>[0]): MediaProviderContext {
  return {
    userId: job.userId,
    reservedCostMicros: BigInt(job.reservedCostMicros),
  };
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
    stage: row.stage,
    currentJobId: row.current_job_id,
    intermediateFileId: row.intermediate_file_id,
    transcript: row.transcript,
    result: row.result_json,
    errorCode: row.error_code,
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

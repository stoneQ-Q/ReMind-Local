import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { releaseJobCost, settleJobCost } from './billing.js';
import {
  confirmAndReserveManagedJobQuote,
  createManagedJobQuote,
} from './job-quotes.js';
import type { JobHandler } from './jobs.js';
import {
  SecureBilibiliAudioFetcher,
  SecureLinkPageFetcher,
  SecureXiaohongshuVideoFetcher,
  SecureXiaoyuzhouAudioFetcher,
  type LinkAudioFetcher,
  type LinkPageFetcher,
  type LinkVideoFetcher,
  validatePublicLinkUrl,
} from './link-page.js';
import {
  createByokMediaProcessingRequest,
  createTemporaryLinkAudioProcessingRequest,
} from './media-processing.js';
import { saveObjectFile } from './object-files.js';
import type { ObjectStore } from './object-store.js';
import {
  ParaformerError,
  type ParaformerClient,
  type ParaformerSegment,
  type ParaformerTranscript,
} from './paraformer-client.js';
import {
  managedTranscriptionCost,
  type ManagedTranscriptionPriceCatalog,
} from './media-pricing.js';
import {
  extractVideoAudioSegments,
  type ExtractedAudioSegment,
} from './video-audio-segments.js';
import type { WhisperMediaClient } from './whisper-media-client.js';

const LINK_JOB_TYPE = 'link.parse';

type LinkNoteRow = {
  id: string;
  user_id: string;
  source_url: string;
  ai_mode: string;
};

export type LinkTranscriptionOptions = {
  priceCatalog: ManagedTranscriptionPriceCatalog | null;
  serverWhisperUserIds: ReadonlySet<string>;
  whisper: WhisperMediaClient | null;
  audioFetcher?: LinkAudioFetcher;
  bilibiliAudioFetcher?: LinkAudioFetcher;
};

export function selectLinkTranscriptionProvider(input: {
  userId: string;
  aiMode: string;
  supportedMedia: boolean;
  paraformerAvailable: boolean;
  managedPricingAvailable: boolean;
  managedDurationAvailable: boolean;
  whisperAvailable: boolean;
  serverWhisperUserIds: ReadonlySet<string>;
}): 'whisper' | 'dashscope' | 'legacy' | 'unavailable' {
  if (!input.supportedMedia) return 'legacy';
  if (
    input.whisperAvailable &&
    input.serverWhisperUserIds.has(input.userId)
  ) {
    return 'whisper';
  }
  if (input.aiMode === 'managed') {
    return input.paraformerAvailable &&
      input.managedPricingAvailable &&
      input.managedDurationAvailable
      ? 'dashscope'
      : 'unavailable';
  }
  return 'legacy';
}

export async function ensureNextLinkParseJob(
  pool: Pool,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orphaned = await client.query<{ id: string }>(
      `SELECT note.id
       FROM notes AS note
       JOIN jobs AS current_job
         ON current_job.id = note.link_job_id
        AND current_job.user_id = note.user_id
       WHERE note.deleted_at IS NULL
         AND note.link_status = 'processing'
         AND current_job.status IN ('failed', 'cancelled')
       ORDER BY note.created_at, note.id
       FOR UPDATE OF note SKIP LOCKED
       LIMIT 1`,
    );
    if (orphaned.rows[0]) {
      await client.query(
        `UPDATE notes AS note
         SET link_status = 'failed',
             link_error_code = COALESCE(job.error_code, job.status::text),
             sync_version = note.sync_version + 1,
             updated_at = now()
         FROM jobs AS job
         WHERE note.id = $1
           AND job.id = note.link_job_id
           AND job.user_id = note.user_id`,
        [orphaned.rows[0].id],
      );
      await client.query('COMMIT');
      return `reconciled:${orphaned.rows[0].id}`;
    }

    const candidate = await client.query<{
      id: string;
      user_id: string;
      link_generation: string;
    }>(
      `SELECT note.id, note.user_id, note.link_generation
       FROM notes AS note
       LEFT JOIN jobs AS current_job
         ON current_job.id = note.link_job_id
        AND current_job.user_id = note.user_id
       WHERE note.deleted_at IS NULL
         AND note.source_url IS NOT NULL
         AND note.link_status = 'pending'
         AND (
           note.link_job_id IS NULL
           OR current_job.status IN ('succeeded', 'failed', 'cancelled')
         )
       ORDER BY note.created_at, note.id
       FOR UPDATE OF note SKIP LOCKED
       LIMIT 1`,
    );
    const row = candidate.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    const generation = BigInt(row.link_generation) + 1n;
    const job = await client.query<{ id: string }>(
      `INSERT INTO jobs (
         user_id, type, idempotency_key, input_json,
         max_attempts, timeout_seconds
       ) VALUES ($1, $2, $3, $4::jsonb, 3, 1200)
       RETURNING id`,
      [
        row.user_id,
        LINK_JOB_TYPE,
        `link-parse:${row.id}:${generation}`,
        JSON.stringify({
          noteId: row.id,
          generation: generation.toString(),
        }),
      ],
    );
    const jobId = requiredRow(job.rows[0]).id;
    await client.query(
      `UPDATE notes
       SET link_status = 'processing',
           link_error_code = NULL,
           link_generation = $1,
           link_job_id = $2,
           sync_version = sync_version + 1,
           updated_at = now()
       WHERE user_id = $3 AND id = $4`,
      [generation.toString(), jobId, row.user_id, row.id],
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

export function createLinkParseHandler(
  pool: Pool,
  store: ObjectStore,
  fetcher: LinkPageFetcher = new SecureLinkPageFetcher(),
  videoFetcher: LinkVideoFetcher = new SecureXiaohongshuVideoFetcher(),
  paraformer: ParaformerClient | null = null,
  transcriptionOptions: LinkTranscriptionOptions | null = null,
): JobHandler {
  return async (job, signal) => {
    const { noteId, generation } = parseLinkJobInput(job.input);
    try {
      const note = await loadLinkNote(
        pool,
        job.userId,
        noteId,
        generation,
        job.id,
      );
      const snapshot = await fetcher.fetch(note.source_url, signal);
      const finalUrl = validatePublicLinkUrl(snapshot.url);
      const images = sanitizeSnapshotImages(
        snapshot.platform,
        snapshot.images,
      );
      const supportedMedia = Boolean(
        (snapshot.platform === 'xiaoyuzhou' &&
          snapshot.mediaType === 'audio' &&
          snapshot.transientAudioUrl) ||
          (snapshot.platform === 'xiaohongshu' &&
            snapshot.mediaType === 'video' &&
            snapshot.transientVideoUrl) ||
          (snapshot.platform === 'bilibili' &&
            snapshot.mediaType === 'video' &&
            snapshot.transientAudioUrl &&
            transcriptionOptions?.whisper &&
            transcriptionOptions.serverWhisperUserIds.has(job.userId)),
      );
      const transcriptionProvider = selectLinkTranscriptionProvider({
        userId: job.userId,
        aiMode: note.ai_mode,
        supportedMedia,
        paraformerAvailable: Boolean(paraformer),
        managedPricingAvailable: Boolean(transcriptionOptions?.priceCatalog),
        managedDurationAvailable:
          Number.isInteger(snapshot.durationSeconds) &&
          (snapshot.durationSeconds ?? 0) >= 1,
        whisperAvailable: Boolean(transcriptionOptions?.whisper),
        serverWhisperUserIds:
          transcriptionOptions?.serverWhisperUserIds ?? new Set(),
      });
      if (transcriptionProvider === 'unavailable') {
        throw new Error('managed_transcription_unavailable');
      }
      const managedApiTranscription =
        transcriptionProvider === 'dashscope' &&
        paraformer &&
        transcriptionOptions?.priceCatalog &&
        supportedMedia
          ? await transcribeManagedLinkMedia(pool, paraformer, {
              userId: job.userId,
              noteId,
              generation,
              mediaType: snapshot.mediaType as 'audio' | 'video',
              mediaUrl:
                snapshot.transientAudioUrl ?? snapshot.transientVideoUrl ?? '',
              estimatedDurationSeconds: snapshot.durationSeconds!,
              signal,
              finalAttempt: job.attemptCount >= job.maxAttempts,
              priceCatalog: transcriptionOptions.priceCatalog,
            })
          : null;
      const ownerTranscription =
        transcriptionProvider === 'whisper' && transcriptionOptions?.whisper
          ? await transcribeOwnerLinkMedia(
              snapshot,
              videoFetcher,
              transcriptionOptions.audioFetcher ??
                new SecureXiaoyuzhouAudioFetcher(),
              transcriptionOptions.bilibiliAudioFetcher ??
                new SecureBilibiliAudioFetcher(),
              transcriptionOptions.whisper,
              signal,
            )
          : null;
      const mediaTranscription =
        snapshot.embeddedTranscript ??
        managedApiTranscription ??
        ownerTranscription ??
        (paraformer &&
        snapshot.platform === 'xiaoyuzhou' &&
        snapshot.mediaType === 'audio' &&
        snapshot.transientAudioUrl
          ? await transcribeXiaoyuzhouEpisode(pool, paraformer, {
              userId: job.userId,
              noteId,
              generation,
              audioUrl: snapshot.transientAudioUrl,
              signal,
            })
          : null);
      const video =
        !mediaTranscription &&
        snapshot.platform === 'xiaohongshu' &&
        snapshot.mediaType === 'video' &&
        snapshot.transientVideoUrl
          ? await videoFetcher.fetch(snapshot.transientVideoUrl, signal)
          : null;
      const videoSourceFile = video
        ? await saveObjectFile(pool, store, {
            userId: job.userId,
            contentType: video.contentType,
            content: video.content,
            purpose: 'source',
            originalName: `xiaohongshu-${noteId}.mp4`,
          })
        : null;
      const sourceFileId = videoSourceFile?.id ?? null;
      const sourceText = mediaTranscription
        ? snapshot.platform === 'bilibili'
          ? buildBilibiliEvidenceText(snapshot.text, mediaTranscription)
          : snapshot.mediaType === 'video'
          ? buildMediaEvidenceText(
              'video',
              snapshot.text,
              mediaTranscription.transcript,
              null,
            )
          : buildXiaoyuzhouEvidenceText(snapshot.text, mediaTranscription)
        : snapshot.text;
      const updated = await pool.query(
        `UPDATE notes
         SET source_url = $1,
             source_page_title = $2,
             source_page_description = $3,
             source_page_site = $4,
             source_page_text = $5,
             link_platform = $6,
             link_media_type = $7,
             link_images_json = $8::jsonb,
             link_duration_seconds = $9,
             link_source_file_id = $10,
             link_media_request_id = $11,
             link_media_status = $12,
             link_media_error_code = NULL,
             link_status = 'ready',
             link_error_code = NULL,
             sync_version = sync_version + 1,
             updated_at = now()
         WHERE user_id = $13 AND id = $14
           AND deleted_at IS NULL
           AND link_status = 'processing'
           AND link_generation = $15 AND link_job_id = $16`,
        [
          finalUrl,
          snapshot.title.slice(0, 300),
          snapshot.description.slice(0, 600),
          snapshot.site.slice(0, 255),
          sourceText.slice(0, 80_000),
          snapshot.platform,
          snapshot.mediaType,
          JSON.stringify(images),
          snapshot.durationSeconds,
          sourceFileId,
          null,
          mediaTranscription
            ? 'succeeded'
            : videoSourceFile
              ? 'awaiting_key'
              : null,
          job.userId,
          noteId,
          generation,
          job.id,
        ],
      );
      if (updated.rowCount !== 1) throw new Error('link_job_superseded');
      return {
        platform: snapshot.platform,
        mediaType: snapshot.mediaType,
        imageCount: images.length,
        durationSeconds: snapshot.durationSeconds,
        transcription: mediaTranscription ? 'succeeded' : 'skipped',
      };
    } catch (error) {
      await pool.query(
        `UPDATE notes
         SET link_status = $1,
             link_error_code = $2,
             sync_version = sync_version + 1,
             updated_at = now()
         WHERE user_id = $3 AND id = $4
           AND deleted_at IS NULL
           AND link_generation = $5 AND link_job_id = $6`,
        [
          job.attemptCount >= job.maxAttempts ? 'failed' : 'processing',
          normalizeErrorCode(error),
          job.userId,
          noteId,
          generation,
          job.id,
        ],
      );
      throw error;
    }
  };
}

export async function ensureNextLinkMediaRequest(
  pool: Pool,
  serverWhisperAvailable = false,
): Promise<string | null> {
  const candidate = await pool.query<{
    id: string;
    user_id: string;
    link_source_file_id: string;
    link_generation: string;
    link_media_type: 'video' | 'audio';
    link_duration_seconds: number | null;
  }>(
    `SELECT note.id, note.user_id, note.link_source_file_id,
            note.link_generation, note.link_media_type,
            note.link_duration_seconds
     FROM notes AS note
     JOIN users AS owner ON owner.id = note.user_id
     WHERE note.deleted_at IS NULL
       AND note.link_media_type IN ('video', 'audio')
       AND note.link_source_file_id IS NOT NULL
       AND note.link_media_request_id IS NULL
       AND note.link_media_status IN ('awaiting_key', 'pending')
       AND owner.status = 'active'
       AND owner.ai_mode = 'bring_your_own_key'
       AND (
         (
           note.link_media_type = 'video'
           AND EXISTS (
             SELECT 1 FROM api_credentials
             WHERE user_id = note.user_id AND provider = 'deepseek'
               AND revoked_at IS NULL
           )
         )
         OR (
           note.link_media_type = 'audio'
           AND (
             $1::boolean
             OR EXISTS (
               SELECT 1 FROM api_credentials
               WHERE user_id = note.user_id AND provider = 'zhipu'
                 AND revoked_at IS NULL
             )
           )
         )
       )
     ORDER BY note.created_at, note.id
     LIMIT 1`,
    [serverWhisperAvailable],
  );
  const row = candidate.rows[0];
  if (!row) return null;
  const request =
    row.link_media_type === 'audio'
      ? await createTemporaryLinkAudioProcessingRequest(pool, {
          userId: row.user_id,
          sourceFileId: row.link_source_file_id,
          idempotencyKey: `link-audio:${row.id}:${row.link_generation}`,
          durationSeconds: row.link_duration_seconds ?? 1,
          serverWhisperAvailable,
        })
      : await createByokMediaProcessingRequest(pool, {
          userId: row.user_id,
          sourceFileId: row.link_source_file_id,
          idempotencyKey: `link-video:${row.id}:${row.link_generation}`,
        });
  await pool.query(
    `UPDATE notes
     SET link_media_request_id = $1,
         link_media_status = 'pending',
         link_media_error_code = NULL,
         sync_version = sync_version + 1,
         updated_at = now()
     WHERE user_id = $2 AND id = $3
       AND link_source_file_id = $4
       AND link_media_request_id IS NULL`,
    [request.id, row.user_id, row.id, row.link_source_file_id],
  );
  return `created:${row.id}:${request.id}`;
}

export async function reconcileNextLinkMediaRequest(
  pool: Pool,
): Promise<string | null> {
  const result = await pool.query<{
    id: string;
    user_id: string;
    source_page_text: string | null;
    link_media_type: 'video' | 'audio';
    link_source_file_id: string;
    request_status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
    transcript: string | null;
    result_json: unknown;
    error_code: string | null;
  }>(
    `SELECT note.id, note.user_id, note.source_page_text,
            note.link_media_type, note.link_source_file_id,
            request.status AS request_status, request.transcript,
            request.result_json, request.error_code
     FROM notes AS note
     JOIN media_processing_requests AS request
       ON request.user_id = note.user_id
      AND request.id = note.link_media_request_id
     WHERE note.deleted_at IS NULL
       AND note.link_media_status IN ('pending', 'processing')
       AND (
         request.status IN ('succeeded', 'failed', 'cancelled')
         OR (
           note.link_media_status = 'pending'
           AND request.status = 'processing'
         )
       )
     ORDER BY note.created_at, note.id
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_status === 'processing') {
    await pool.query(
      `UPDATE notes
       SET link_media_status = 'processing', updated_at = now()
       WHERE user_id = $1 AND id = $2
         AND link_media_status = 'pending'`,
      [row.user_id, row.id],
    );
    return `processing:${row.id}`;
  }
  if (row.request_status === 'succeeded') {
    const text = buildMediaEvidenceText(
      row.link_media_type,
      row.source_page_text,
      row.transcript,
      row.result_json,
    );
    await pool.query(
      `UPDATE notes
       SET source_page_text = $1,
           link_media_status = 'succeeded',
           link_media_error_code = NULL,
           link_source_file_id = CASE
             WHEN link_media_type = 'audio' THEN NULL
             ELSE link_source_file_id
           END,
           sync_version = sync_version + 1,
           updated_at = now()
       WHERE user_id = $2 AND id = $3
         AND link_media_status IN ('pending', 'processing')`,
      [text, row.user_id, row.id],
    );
  } else {
    await pool.query(
      `UPDATE notes
       SET link_media_status = 'failed',
           link_media_error_code = $1,
           link_source_file_id = CASE
             WHEN link_media_type = 'audio' THEN NULL
             ELSE link_source_file_id
           END,
           sync_version = sync_version + 1,
           updated_at = now()
       WHERE user_id = $2 AND id = $3
         AND link_media_status IN ('pending', 'processing')`,
      [row.error_code ?? row.request_status, row.user_id, row.id],
    );
  }
  await expireTemporaryLinkSource(pool, row.user_id, row.link_source_file_id);
  return `reconciled:${row.id}:${row.request_status}`;
}

type LinkTranscriptionRow = {
  provider_task_id: string;
  status: 'submitted' | 'succeeded' | 'failed';
  transcript: string | null;
  segments_json: unknown;
  error_code: string | null;
  billing_job_id: string | null;
  estimated_duration_seconds: number | null;
  billable_duration_seconds: number | null;
};

async function transcribeManagedLinkMedia(
  pool: Pool,
  paraformer: ParaformerClient,
  input: {
    userId: string;
    noteId: string;
    generation: string;
    mediaType: 'audio' | 'video';
    mediaUrl: string;
    estimatedDurationSeconds: number;
    signal: AbortSignal;
    finalAttempt: boolean;
    priceCatalog: ManagedTranscriptionPriceCatalog;
  },
): Promise<ParaformerTranscript> {
  const estimatedDurationSeconds = Math.min(
    43_200,
    Math.max(1, Math.ceil(input.estimatedDurationSeconds)),
  );
  const estimateMicros = managedTranscriptionCost(
    input.priceCatalog,
    estimatedDurationSeconds,
  );
  const idempotencyKey =
    `managed-link-transcription:${input.noteId}:${input.generation}`;
  let row = await loadXiaoyuzhouTranscription(pool, input);
  if (!row) {
    const quote = await createManagedJobQuote(
      pool,
      input.userId,
      'ai.transcription',
      'dashscope',
      estimateMicros,
      idempotencyKey,
      {
        noteId: input.noteId,
        generation: input.generation,
        mediaType: input.mediaType,
        estimatedDurationSeconds,
      },
    );
    await confirmAndReserveManagedJobQuote(
      pool,
      input.userId,
      quote.jobId,
    );
    let taskId: string;
    try {
      taskId = await paraformer.submit(input.mediaUrl, input.signal);
    } catch (error) {
      await releaseJobCost(
        pool,
        input.userId,
        quote.jobId,
        'failed',
        idempotencyKey,
      ).catch(() => undefined);
      throw error;
    }
    await pool.query(
      `INSERT INTO link_transcriptions (
         user_id, note_id, link_generation, provider_task_id,
         media_type, provider, billing_job_id, estimated_duration_seconds
       ) VALUES ($1, $2, $3, $4, $5, 'dashscope', $6, $7)
       ON CONFLICT (user_id, note_id, link_generation) DO NOTHING`,
      [
        input.userId,
        input.noteId,
        input.generation,
        taskId,
        input.mediaType,
        quote.jobId,
        estimatedDurationSeconds,
      ],
    );
    row = await loadXiaoyuzhouTranscription(pool, input);
    if (!row) throw new Error('paraformer_task_not_saved');
  }
  if (row.status === 'failed') {
    throw new Error(row.error_code ?? 'paraformer_task_failed');
  }
  if (row.status === 'succeeded') {
    const transcript = row.transcript?.trim() ?? '';
    if (!transcript) throw new Error('paraformer_transcript_missing');
    return {
      transcript,
      segments: parseStoredSegments(row.segments_json),
      billableDurationSeconds: row.billable_duration_seconds,
    };
  }
  if (!row.billing_job_id || !row.estimated_duration_seconds) {
    throw new Error('managed_transcription_billing_missing');
  }
  try {
    const result = await paraformer.waitForTranscript(
      row.provider_task_id,
      input.signal,
    );
    const billableDurationSeconds = Math.min(
      row.estimated_duration_seconds,
      result.billableDurationSeconds ?? row.estimated_duration_seconds,
    );
    await settleJobCost(
      pool,
      input.userId,
      row.billing_job_id,
      managedTranscriptionCost(input.priceCatalog, billableDurationSeconds),
      idempotencyKey,
    );
    const updated = await pool.query(
      `UPDATE link_transcriptions
       SET status = 'succeeded', transcript = $1,
           segments_json = $2::jsonb, error_code = NULL,
           billable_duration_seconds = $3,
           finished_at = now(), updated_at = now()
       WHERE user_id = $4 AND note_id = $5 AND link_generation = $6
         AND provider_task_id = $7 AND status = 'submitted'`,
      [
        result.transcript,
        JSON.stringify(result.segments),
        billableDurationSeconds,
        input.userId,
        input.noteId,
        input.generation,
        row.provider_task_id,
      ],
    );
    if (updated.rowCount !== 1) throw new Error('paraformer_task_superseded');
    return { ...result, billableDurationSeconds };
  } catch (error) {
    if (
      (error instanceof ParaformerError && error.terminal) ||
      input.finalAttempt
    ) {
      await releaseJobCost(
        pool,
        input.userId,
        row.billing_job_id,
        'failed',
        idempotencyKey,
      ).catch(() => undefined);
      await pool.query(
        `UPDATE link_transcriptions
         SET status = 'failed', error_code = $1,
             finished_at = now(), updated_at = now()
         WHERE user_id = $2 AND note_id = $3 AND link_generation = $4
           AND provider_task_id = $5 AND status = 'submitted'`,
        [
          normalizeErrorCode(error),
          input.userId,
          input.noteId,
          input.generation,
          row.provider_task_id,
        ],
      );
    }
    throw error;
  }
}

async function transcribeOwnerLinkMedia(
  snapshot: Awaited<ReturnType<LinkPageFetcher['fetch']>>,
  videoFetcher: LinkVideoFetcher,
  audioFetcher: LinkAudioFetcher,
  bilibiliAudioFetcher: LinkAudioFetcher,
  whisper: WhisperMediaClient,
  signal: AbortSignal,
): Promise<ParaformerTranscript | null> {
  let segments: ExtractedAudioSegment[] | null = null;
  if (
    snapshot.platform === 'xiaoyuzhou' &&
    snapshot.mediaType === 'audio' &&
    snapshot.transientAudioUrl
  ) {
    segments = (await audioFetcher.fetch(snapshot.transientAudioUrl, signal))
      .segments;
  } else if (
    snapshot.platform === 'bilibili' &&
    snapshot.mediaType === 'video' &&
    snapshot.transientAudioUrl
  ) {
    segments = (
      await bilibiliAudioFetcher.fetch(
        snapshot.transientAudioUrl,
        signal,
        snapshot.url,
      )
    ).segments;
  } else if (
    snapshot.platform === 'xiaohongshu' &&
    snapshot.mediaType === 'video' &&
    snapshot.transientVideoUrl
  ) {
    const video = await videoFetcher.fetch(snapshot.transientVideoUrl, signal);
    const directory = await mkdtemp(join(tmpdir(), 'remind-owner-video-'));
    try {
      const sourcePath = join(directory, 'source.mp4');
      await writeFile(sourcePath, video.content, { mode: 0o600 });
      segments = await extractVideoAudioSegments(sourcePath, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!segments) return null;
  const transcriptParts: string[] = [];
  const transcriptSegments: ParaformerSegment[] = [];
  for (const segment of segments) {
    const result = await whisper.transcribeAudio(
      { content: segment.content, contentType: 'audio/mpeg' },
      signal,
    );
    transcriptParts.push(result.transcript);
    transcriptSegments.push({
      startSeconds: segment.startSeconds,
      endSeconds: segment.startSeconds + 28,
      text: result.transcript,
      speakerId: null,
    });
  }
  return {
    transcript: transcriptParts.join('\n').slice(0, 2_000_000),
    segments: transcriptSegments.slice(0, 20_000),
    billableDurationSeconds: null,
  };
}

async function transcribeXiaoyuzhouEpisode(
  pool: Pool,
  paraformer: ParaformerClient,
  input: {
    userId: string;
    noteId: string;
    generation: string;
    audioUrl: string;
    signal: AbortSignal;
  },
): Promise<ParaformerTranscript> {
  let row = await loadXiaoyuzhouTranscription(pool, input);
  if (!row) {
    const taskId = await paraformer.submit(input.audioUrl, input.signal);
    await pool.query(
      `INSERT INTO link_transcriptions (
         user_id, note_id, link_generation, provider_task_id
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, note_id, link_generation) DO NOTHING`,
      [input.userId, input.noteId, input.generation, taskId],
    );
    row = await loadXiaoyuzhouTranscription(pool, input);
    if (!row) throw new Error('paraformer_task_not_saved');
  }
  if (row.status === 'failed') {
    throw new Error(row.error_code ?? 'paraformer_task_failed');
  }
  if (row.status === 'succeeded') {
    const transcript = row.transcript?.trim() ?? '';
    if (!transcript) throw new Error('paraformer_transcript_missing');
    return {
      transcript,
      segments: parseStoredSegments(row.segments_json),
      billableDurationSeconds: row.billable_duration_seconds,
    };
  }
  try {
    const result = await paraformer.waitForTranscript(
      row.provider_task_id,
      input.signal,
    );
    const updated = await pool.query(
      `UPDATE link_transcriptions
       SET status = 'succeeded', transcript = $1,
           segments_json = $2::jsonb, error_code = NULL,
           finished_at = now(), updated_at = now()
       WHERE user_id = $3 AND note_id = $4 AND link_generation = $5
         AND provider_task_id = $6 AND status = 'submitted'`,
      [
        result.transcript,
        JSON.stringify(result.segments),
        input.userId,
        input.noteId,
        input.generation,
        row.provider_task_id,
      ],
    );
    if (updated.rowCount !== 1) throw new Error('paraformer_task_superseded');
    return result;
  } catch (error) {
    if (error instanceof ParaformerError && error.terminal) {
      await pool.query(
        `UPDATE link_transcriptions
         SET status = 'failed', error_code = $1,
             finished_at = now(), updated_at = now()
         WHERE user_id = $2 AND note_id = $3 AND link_generation = $4
           AND provider_task_id = $5 AND status = 'submitted'`,
        [
          normalizeErrorCode(error),
          input.userId,
          input.noteId,
          input.generation,
          row.provider_task_id,
        ],
      );
    }
    throw error;
  }
}

async function loadXiaoyuzhouTranscription(
  pool: Pool,
  input: { userId: string; noteId: string; generation: string },
): Promise<LinkTranscriptionRow | null> {
  const result = await pool.query<LinkTranscriptionRow>(
    `SELECT provider_task_id, status, transcript, segments_json, error_code,
            billing_job_id, estimated_duration_seconds,
            billable_duration_seconds
     FROM link_transcriptions
     WHERE user_id = $1 AND note_id = $2 AND link_generation = $3`,
    [input.userId, input.noteId, input.generation],
  );
  return result.rows[0] ?? null;
}

function parseStoredSegments(value: unknown): ParaformerSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: ParaformerSegment[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const data = item as Record<string, unknown>;
    if (
      typeof data.startSeconds !== 'number' ||
      typeof data.endSeconds !== 'number' ||
      typeof data.text !== 'string'
    ) {
      continue;
    }
    segments.push({
      startSeconds: data.startSeconds,
      endSeconds: data.endSeconds,
      text: data.text,
      speakerId:
        typeof data.speakerId === 'number' ? data.speakerId : null,
    });
  }
  return segments.slice(0, 20_000);
}

function buildXiaoyuzhouEvidenceText(
  existingText: string,
  transcription: ParaformerTranscript,
): string {
  const timestamped = transcription.segments.length
    ? transcription.segments
        .map(
          (segment) =>
            `[${formatTimestamp(segment.startSeconds)}] ${segment.text}`,
        )
        .join('\n')
    : transcription.transcript;
  return `${existingText.trim()}\n\n音频转写\n${timestamped}`.slice(0, 80_000);
}

function buildBilibiliEvidenceText(
  existingText: string,
  transcription: ParaformerTranscript,
): string {
  const timestamped = transcription.segments.length
    ? transcription.segments
        .map(
          (segment) =>
            `[${formatTimestamp(segment.startSeconds)}] ${segment.text}`,
        )
        .join('\n')
    : transcription.transcript;
  return `${existingText.trim()}\n\n视频语音转写\n${timestamped}`.slice(0, 80_000);
}

function formatTimestamp(seconds: number): string {
  const bounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(bounded / 3_600);
  const minutes = Math.floor((bounded % 3_600) / 60);
  const remainder = bounded % 60;
  return [hours, minutes, remainder]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function buildMediaEvidenceText(
  mediaType: 'video' | 'audio',
  existingText: string | null,
  transcript: string | null,
  result: unknown,
): string {
  const data =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  const highlights = Array.isArray(data.highlights)
    ? data.highlights.filter((item): item is string => typeof item === 'string')
    : [];
  const sections = [
    existingText?.trim() ?? '',
    mediaType === 'video' && summary
      ? `视频内容摘要\n${summary}${
          highlights.length ? `\n${highlights.map((item) => `- ${item}`).join('\n')}` : ''
      }`
      : '',
    transcript?.trim()
      ? `${mediaType === 'audio' ? '音频转写' : '视频语音转写'}\n${transcript.trim()}`
      : '',
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 80_000);
}

async function expireTemporaryLinkSource(
  pool: Pool,
  userId: string,
  fileId: string,
): Promise<void> {
  await pool.query(
    `UPDATE files
     SET expires_at = LEAST(expires_at, now()), updated_at = now()
     WHERE user_id = $1 AND id = $2
       AND purpose = 'temporary' AND status = 'ready'`,
    [userId, fileId],
  );
}

async function loadLinkNote(
  pool: Pool,
  userId: string,
  noteId: string,
  generation: string,
  jobId: string,
): Promise<LinkNoteRow> {
  const result = await pool.query<LinkNoteRow>(
    `SELECT note.id, note.user_id, note.source_url, owner.ai_mode
     FROM notes AS note
     JOIN users AS owner ON owner.id = note.user_id
     WHERE note.user_id = $1 AND note.id = $2
       AND note.deleted_at IS NULL
       AND note.source_url IS NOT NULL
       AND note.link_status = 'processing'
       AND note.link_generation = $3 AND note.link_job_id = $4`,
    [userId, noteId, generation, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('link_note_not_found');
  return row;
}

function parseLinkJobInput(
  input: unknown,
): { noteId: string; generation: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid_link_job_input');
  }
  const noteId = (input as Record<string, unknown>).noteId;
  const generation = (input as Record<string, unknown>).generation;
  if (
    typeof noteId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      noteId,
    ) ||
    typeof generation !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(generation)
  ) {
    throw new Error('invalid_link_job_input');
  }
  return { noteId, generation };
}

function normalizeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : 'link_parse_failed';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return normalized || 'link_parse_failed';
}

function sanitizeSnapshotImages(
  platform: 'web' | 'xiaohongshu' | 'xiaoyuzhou' | 'bilibili',
  values: readonly string[],
): string[] {
  if (platform !== 'xiaohongshu') return [];
  const images: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 2_048) continue;
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol === 'https:' &&
        (hostname === 'xhscdn.com' || hostname.endsWith('.xhscdn.com'))
      ) {
        images.push(url.toString());
      }
    } catch {
      // Ignore media metadata that falls outside the trusted CDN boundary.
    }
    if (images.length >= 12) break;
  }
  return [...new Set(images)];
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

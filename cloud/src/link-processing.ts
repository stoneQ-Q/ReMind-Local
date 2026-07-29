import type { Pool, PoolClient } from 'pg';

import type { JobHandler } from './jobs.js';
import {
  SecureLinkPageFetcher,
  type LinkPageFetcher,
  validatePublicLinkUrl,
} from './link-page.js';

const LINK_JOB_TYPE = 'link.parse';

type LinkNoteRow = {
  id: string;
  user_id: string;
  source_url: string;
};

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
       ) VALUES ($1, $2, $3, $4::jsonb, 3, 45)
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
  fetcher: LinkPageFetcher = new SecureLinkPageFetcher(),
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
             link_status = 'ready',
             link_error_code = NULL,
             sync_version = sync_version + 1,
             updated_at = now()
         WHERE user_id = $10 AND id = $11
           AND deleted_at IS NULL
           AND link_status = 'processing'
           AND link_generation = $12 AND link_job_id = $13`,
        [
          finalUrl,
          snapshot.title.slice(0, 300),
          snapshot.description.slice(0, 600),
          snapshot.site.slice(0, 255),
          snapshot.text.slice(0, 24_000),
          snapshot.platform,
          snapshot.mediaType,
          JSON.stringify(images),
          snapshot.durationSeconds,
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

async function loadLinkNote(
  pool: Pool,
  userId: string,
  noteId: string,
  generation: string,
  jobId: string,
): Promise<LinkNoteRow> {
  const result = await pool.query<LinkNoteRow>(
    `SELECT id, user_id, source_url
     FROM notes
     WHERE user_id = $1 AND id = $2
       AND deleted_at IS NULL
       AND source_url IS NOT NULL
       AND link_status = 'processing'
       AND link_generation = $3 AND link_job_id = $4`,
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
  platform: 'web' | 'xiaohongshu',
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

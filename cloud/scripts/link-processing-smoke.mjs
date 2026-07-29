import assert from 'node:assert/strict';

import pg from 'pg';

import {
  getUserJob,
  processNextCancellation,
  requestJobCancellation,
  runNextJob,
} from '../dist/jobs.js';
import {
  createLinkParseHandler,
  ensureNextLinkParseJob,
} from '../dist/link-processing.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });
const webUrl = 'https://example.com/article?source=user-a';
const xhsUrl = 'https://www.xiaohongshu.com/explore/note-b';
const transientVideoUrl =
  'https://sns-video.xhscdn.com/private-temporary-video.mp4?token=do-not-store';
const fetchCalls = new Map();
const fetcher = {
  async fetch(url) {
    const calls = (fetchCalls.get(url) ?? 0) + 1;
    fetchCalls.set(url, calls);
    if (url === webUrl && calls === 1) {
      throw new Error('temporary_page_failure');
    }
    if (url === webUrl) {
      return {
        url: webUrl,
        title: '用户 A 的网页',
        description: '网页说明',
        site: 'example.com',
        text: '网页正文'.repeat(40),
        images: [],
        platform: 'web',
        mediaType: 'web',
        durationSeconds: null,
      };
    }
    if (url === xhsUrl) {
      return {
        url: xhsUrl,
        title: '用户 B 的小红书视频',
        description: '',
        site: 'xiaohongshu.com',
        text: '小红书正文'.repeat(30),
        images: [],
        platform: 'xiaohongshu',
        mediaType: 'video',
        durationSeconds: 96,
        transientVideoUrl,
      };
    }
    throw new Error('unexpected_test_url');
  },
};

try {
  const firstUser = await createUser();
  const secondUser = await createUser();
  const firstNote = await createLinkNote(
    firstUser,
    'link-user-a',
    webUrl,
    '为了下周内容规划',
  );
  const secondNote = await createLinkNote(
    secondUser,
    'link-user-b',
    xhsUrl,
    '保存视频里的方法',
  );

  const firstJob = await ensureNextLinkParseJob(pool);
  const secondJob = await ensureNextLinkParseJob(pool);
  assert.ok(firstJob);
  assert.ok(secondJob);
  assert.equal(await ensureNextLinkParseJob(pool), null);

  const handlers = new Map([
    ['link.parse', createLinkParseHandler(pool, fetcher)],
  ]);
  await runNextJob(pool, 'link-worker', handlers, { retryBaseMs: 0 });
  const firstFailure = await pool.query(
    `SELECT link_status, link_error_code, source_url, content
     FROM notes WHERE user_id = $1 AND id = $2`,
    [firstUser, firstNote],
  );
  assert.equal(firstFailure.rows[0].link_status, 'processing');
  assert.equal(firstFailure.rows[0].link_error_code, 'temporary_page_failure');
  assert.equal(firstFailure.rows[0].source_url, webUrl);
  assert.equal(firstFailure.rows[0].content, '原始链接记录 link-user-a');

  assert.equal(
    await runNextJob(pool, 'link-worker', handlers, { retryBaseMs: 0 }),
    true,
  );
  assert.equal(
    await runNextJob(pool, 'link-worker', handlers, { retryBaseMs: 0 }),
    true,
  );
  assert.equal(
    await runNextJob(pool, 'link-worker', handlers, { retryBaseMs: 0 }),
    false,
  );

  const notes = await pool.query(
    `SELECT id, user_id, source_url, user_context, source_page_title,
            source_page_site, source_page_text, link_platform,
            link_media_type, link_images_json, link_duration_seconds,
            link_status, link_error_code, sync_version
     FROM notes WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[firstNote, secondNote]],
  );
  assert.equal(notes.rowCount, 2);
  const webNote = notes.rows.find((row) => row.id === firstNote);
  const xhsNote = notes.rows.find((row) => row.id === secondNote);
  assert.equal(webNote.user_id, firstUser);
  assert.equal(webNote.link_status, 'ready');
  assert.equal(webNote.link_error_code, null);
  assert.equal(webNote.source_page_title, '用户 A 的网页');
  assert.equal(webNote.link_platform, 'web');
  assert.equal(Number(webNote.sync_version) >= 3, true);
  assert.equal(xhsNote.user_id, secondUser);
  assert.equal(xhsNote.link_status, 'ready');
  assert.equal(xhsNote.link_platform, 'xiaohongshu');
  assert.equal(xhsNote.link_media_type, 'video');
  assert.equal(xhsNote.link_duration_seconds, 96);
  assert.deepEqual(xhsNote.link_images_json, []);

  const jobs = await pool.query(
    `SELECT id, user_id, input_json, result_json, status
     FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[firstJob, secondJob]],
  );
  assert.equal(jobs.rows.every((row) => row.status === 'succeeded'), true);
  const serializedJobs = JSON.stringify(jobs.rows);
  assert.equal(serializedJobs.includes(webUrl), false);
  assert.equal(serializedJobs.includes(xhsUrl), false);
  assert.equal(serializedJobs.includes(transientVideoUrl), false);
  assert.equal(
    jobs.rows.every(
      (row) =>
        typeof row.input_json.noteId === 'string' &&
        typeof row.input_json.generation === 'string',
    ),
    true,
  );
  assert.equal(
    JSON.stringify(notes.rows).includes(transientVideoUrl),
    false,
  );

  const crossTenant = await pool.query(
    `SELECT count(*)::int AS count
     FROM notes WHERE user_id = $1 AND id = $2`,
    [firstUser, secondNote],
  );
  assert.equal(crossTenant.rows[0].count, 0);

  const cancelledNote = await createLinkNote(
    firstUser,
    'link-cancelled',
    'https://example.com/cancelled',
    '取消测试',
  );
  const cancelledJob = await ensureNextLinkParseJob(pool);
  assert.ok(cancelledJob);
  await requestJobCancellation(pool, firstUser, cancelledJob);
  await processNextCancellation(pool);
  assert.equal(
    (await getUserJob(pool, firstUser, cancelledJob)).status,
    'cancelled',
  );
  assert.match(
    await ensureNextLinkParseJob(pool),
    new RegExp(`^reconciled:${cancelledNote}$`),
  );
  const cancelled = await pool.query(
    `SELECT link_status, link_error_code
     FROM notes WHERE user_id = $1 AND id = $2`,
    [firstUser, cancelledNote],
  );
  assert.equal(cancelled.rows[0].link_status, 'failed');
  assert.equal(cancelled.rows[0].link_error_code, 'job_cancelled');

  console.log(
    'link processing smoke test passed: per-user scheduling, secret-free jobs, retry, cancellation reconciliation, web/XHS metadata, tenant isolation, and transient media URL exclusion',
  );
} finally {
  await pool.end();
}

async function createUser() {
  const user = await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = user.rows[0].id;
  await pool.query('INSERT INTO billing_accounts (user_id) VALUES ($1)', [userId]);
  return userId;
}

async function createLinkNote(userId, clientId, sourceUrl, userContext) {
  const result = await pool.query(
    `INSERT INTO notes (
       user_id, client_id, title, content, source, record_type,
       content_kind, source_url, user_context, link_status
     ) VALUES (
       $1, $2, '链接记录', $3, 'app', 'capture',
       'link', $4, $5, 'pending'
     )
     RETURNING id`,
    [userId, clientId, `原始链接记录 ${clientId}`, sourceUrl, userContext],
  );
  return result.rows[0].id;
}

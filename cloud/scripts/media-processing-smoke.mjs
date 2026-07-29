import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import {
  saveApiCredential,
} from '../dist/ai-settings.js';
import { creditBalance, getBillingAccount } from '../dist/billing.js';
import { ByokMediaProcessingProvider } from '../dist/byok-media-provider.js';
import { LocalAesGcmCredentialCipher } from '../dist/credential-cipher.js';
import { processNextCancellation, runNextJob } from '../dist/jobs.js';
import { confirmAndReserveManagedJobQuote } from '../dist/job-quotes.js';
import {
  createByokMediaProcessingRequest,
  createManagedMediaProcessingRequest,
  createMediaProcessingHandlers,
  createMediaProcessingRequest,
  ensureNextMediaProcessingJob,
  getUserMediaProcessingRequest,
  MockMediaProcessingProvider,
  requestMediaProcessingCancellation,
} from '../dist/media-processing.js';
import {
  MediaProviderAuthorizationError,
  resolveMediaProviderCredential,
} from '../dist/media-provider-routing.js';
import {
  cleanupNextExpiredObject,
  saveObjectFile,
} from '../dist/object-files.js';
import { LocalFilesystemObjectStore } from '../dist/object-store.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });
const directory = await mkdtemp(join(tmpdir(), 'remind-media-smoke-'));
const store = new LocalFilesystemObjectStore(directory);

try {
  const firstUser = await createUser();
  const secondUser = await createUser();
  const cipher = new LocalAesGcmCredentialCipher(
    'test-v1',
    new Map([['test-v1', randomBytes(32)]]),
  );
  await assert.rejects(
    resolveMediaProviderCredential(pool, cipher, {
      userId: firstUser,
      provider: 'zhipu',
      reservedCostMicros: 0n,
    }),
    (error) =>
      error instanceof MediaProviderAuthorizationError &&
      error.code === 'ai_disabled',
  );
  await saveApiCredential(
    pool,
    cipher,
    firstUser,
    'zhipu',
    'user-zhipu-test-key-123456',
  );
  await pool.query(
    `UPDATE users SET ai_mode = 'bring_your_own_key' WHERE id = $1`,
    [firstUser],
  );
  const byokCredential = await resolveMediaProviderCredential(pool, cipher, {
    userId: firstUser,
    provider: 'zhipu',
    reservedCostMicros: 0n,
  });
  assert.deepEqual(byokCredential, {
    apiKey: 'user-zhipu-test-key-123456',
    mode: 'bring_your_own_key',
    billPlatformCost: false,
  });
  await assert.rejects(
    resolveMediaProviderCredential(pool, cipher, {
      userId: firstUser,
      provider: 'deepseek',
      reservedCostMicros: 0n,
    }),
    (error) =>
      error instanceof MediaProviderAuthorizationError &&
      error.code === 'user_provider_credential_required',
  );
  await pool.query(`UPDATE users SET ai_mode = 'managed' WHERE id = $1`, [
    secondUser,
  ]);
  await assert.rejects(
    resolveMediaProviderCredential(pool, cipher, {
      userId: secondUser,
      provider: 'zhipu',
      reservedCostMicros: 0n,
      managedCredentials: { zhipu: 'platform-zhipu-test-key-123456' },
    }),
    (error) =>
      error instanceof MediaProviderAuthorizationError &&
      error.code === 'managed_reservation_required',
  );
  assert.deepEqual(
    await resolveMediaProviderCredential(pool, cipher, {
      userId: secondUser,
      provider: 'zhipu',
      reservedCostMicros: 100_000n,
      managedCredentials: { zhipu: 'platform-zhipu-test-key-123456' },
    }),
    {
      apiKey: 'platform-zhipu-test-key-123456',
      mode: 'managed',
      billPlatformCost: true,
    },
  );
  const image = await saveObjectFile(pool, store, {
    userId: firstUser,
    contentType: 'image/png',
    content: Buffer.from('private image source'),
    purpose: 'source',
  });
  const audio = await saveObjectFile(pool, store, {
    userId: firstUser,
    contentType: 'audio/mpeg',
    content: Buffer.from('private audio source'),
    purpose: 'source',
  });
  const video = await saveObjectFile(pool, store, {
    userId: firstUser,
    contentType: 'video/mp4',
    content: Buffer.from('private video source'),
    purpose: 'source',
  });
  const secondUserImage = await saveObjectFile(pool, store, {
    userId: secondUser,
    contentType: 'image/jpeg',
    content: Buffer.from('second user private image'),
    purpose: 'source',
  });
  const secondUserVideo = await saveObjectFile(pool, store, {
    userId: secondUser,
    contentType: 'video/mp4',
    content: Buffer.from('second user private video'),
    purpose: 'source',
  });

  await assert.rejects(
    createMediaProcessingRequest(pool, {
      userId: secondUser,
      sourceFileId: image.id,
      idempotencyKey: 'cross-user-source',
    }),
    /media_source_not_found/,
  );

  const imageRequest = await createByokMediaProcessingRequest(pool, {
    userId: firstUser,
    sourceFileId: image.id,
    idempotencyKey: 'image-analysis',
  });
  const repeatedImageRequest = await createByokMediaProcessingRequest(pool, {
    userId: firstUser,
    sourceFileId: image.id,
    idempotencyKey: 'image-analysis',
  });
  assert.equal(repeatedImageRequest.id, imageRequest.id);
  await assert.rejects(
    createByokMediaProcessingRequest(pool, {
      userId: firstUser,
      sourceFileId: audio.id,
      idempotencyKey: 'image-analysis',
    }),
    /media_idempotency_conflict/,
  );

  const defaultHandlers = createMediaProcessingHandlers(pool, store);
  const imageJob = await ensureNextMediaProcessingJob(pool);
  assert.ok(imageJob);
  assert.equal(
    (
      await pool.query(
        `SELECT type, confirmed_at IS NOT NULL AS authorized,
                estimated_cost_micros
         FROM jobs WHERE id = $1`,
        [imageJob],
      )
    ).rows[0].type,
    'ai.image',
  );
  await runNextJob(pool, 'media-image-worker', defaultHandlers, {
    retryBaseMs: 0,
  });
  assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  const completedImage = await getUserMediaProcessingRequest(
    pool,
    firstUser,
    imageRequest.id,
  );
  assert.equal(completedImage.status, 'succeeded');
  assert.match(completedImage.result.description, /^模拟图片分析 /);
  assert.deepEqual(completedImage.result.tags, ['模拟', '图片']);
  assert.equal(
    await getUserMediaProcessingRequest(pool, secondUser, imageRequest.id),
    null,
  );

  let transcriptionCalls = 0;
  const retryProvider = new MockMediaProcessingProvider();
  const originalTranscribe = retryProvider.transcribeAudio.bind(retryProvider);
  retryProvider.transcribeAudio = async (content, signal) => {
    transcriptionCalls += 1;
    if (transcriptionCalls === 1) throw new Error('mock_transient_failure');
    return originalTranscribe(content, signal);
  };
  const retryHandlers = createMediaProcessingHandlers(
    pool,
    store,
    retryProvider,
  );
  const audioRequest = await createByokMediaProcessingRequest(pool, {
    userId: firstUser,
    sourceFileId: audio.id,
    idempotencyKey: 'audio-transcription',
  });
  const audioJob = await ensureNextMediaProcessingJob(pool);
  assert.ok(audioJob);
  await runNextJob(pool, 'media-audio-worker', retryHandlers, {
    retryBaseMs: 0,
  });
  assert.equal(
    (
      await getUserMediaProcessingRequest(pool, firstUser, audioRequest.id)
    ).status,
    'processing',
  );
  await wait(20);
  await runNextJob(pool, 'media-audio-worker', retryHandlers, {
    retryBaseMs: 0,
  });
  assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  const completedAudio = await getUserMediaProcessingRequest(
    pool,
    firstUser,
    audioRequest.id,
  );
  assert.equal(completedAudio.status, 'succeeded');
  assert.match(completedAudio.transcript, /^模拟转写 /);
  assert.equal(transcriptionCalls, 2);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM job_attempts WHERE job_id = $1',
        [audioJob],
      )
    ).rows[0].count,
    2,
  );

  await assert.rejects(
    createByokMediaProcessingRequest(pool, {
      userId: firstUser,
      sourceFileId: video.id,
      idempotencyKey: 'video-missing-deepseek',
    }),
    /media_provider_credential_required/,
  );
  await saveApiCredential(
    pool,
    cipher,
    firstUser,
    'deepseek',
    'user-deepseek-test-key-123456',
  );
  const routedCalls = [];
  const routedProvider = new ByokMediaProcessingProvider(
    pool,
    cipher,
    {
      async analyzeImage(key) {
        routedCalls.push(['image', key]);
        return { description: '路由图片结果', tags: [], model: 'test-vision' };
      },
      async transcribeAudio(key) {
        routedCalls.push(['audio', key]);
        return { transcript: '路由转写结果', model: 'test-asr' };
      },
    },
    {
      async summarizeVideoTranscript(key) {
        routedCalls.push(['video', key]);
        return {
          summary: '路由视频结果',
          highlights: [],
          model: 'test-text',
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    },
  );
  const providerContext = { userId: firstUser, reservedCostMicros: 0n };
  assert.equal(
    (
      await routedProvider.analyzeImage(
        Buffer.from('image'),
        new AbortController().signal,
        providerContext,
        'image/png',
      )
    ).description,
    '路由图片结果',
  );
  assert.equal(
    await routedProvider.transcribeAudio(
      Buffer.from('audio'),
      new AbortController().signal,
      providerContext,
      'audio/mpeg',
    ),
    '路由转写结果',
  );
  assert.equal(
    (
      await routedProvider.analyzeVideoTranscript(
        'transcript',
        new AbortController().signal,
        providerContext,
      )
    ).summary,
    '路由视频结果',
  );
  assert.deepEqual(routedCalls, [
    ['image', 'user-zhipu-test-key-123456'],
    ['audio', 'user-zhipu-test-key-123456'],
    ['video', 'user-deepseek-test-key-123456'],
  ]);
  const videoRequest = await createByokMediaProcessingRequest(pool, {
    userId: firstUser,
    sourceFileId: video.id,
    idempotencyKey: 'video-pipeline',
  });
  const videoStages = [];
  for (let index = 0; index < 3; index += 1) {
    const jobId = await ensureNextMediaProcessingJob(pool);
    assert.ok(jobId);
    const job = await pool.query(
      `SELECT type, input_json, confirmed_at IS NOT NULL AS authorized
       FROM jobs WHERE id = $1`,
      [jobId],
    );
    videoStages.push(job.rows[0].type);
    assert.equal(
      JSON.stringify(job.rows[0].input_json).includes(video.id),
      false,
    );
    if (job.rows[0].type.startsWith('ai.')) {
      assert.equal(job.rows[0].authorized, true);
    }
    await runNextJob(pool, `media-video-worker-${index}`, defaultHandlers, {
      retryBaseMs: 0,
    });
    assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  }
  assert.deepEqual(videoStages, [
    'media.video.prepare',
    'ai.transcription',
    'ai.text',
  ]);
  const completedVideo = await getUserMediaProcessingRequest(
    pool,
    firstUser,
    videoRequest.id,
  );
  assert.equal(completedVideo.status, 'succeeded');
  assert.match(completedVideo.transcript, /^\[00:00\] 模拟转写 /);
  assert.match(completedVideo.transcript, /\[00:28\] 模拟转写 /);
  assert.match(completedVideo.result.summary, /^模拟视频总结：/);
  assert.equal(completedVideo.result.highlights.length, 2);
  assert.ok(completedVideo.intermediateFileId);

  const intermediate = await pool.query(
    `SELECT purpose, media_kind, status, expires_at <= now() AS expired
     FROM files
     WHERE user_id = $1 AND id = $2`,
    [firstUser, completedVideo.intermediateFileId],
  );
  assert.deepEqual(intermediate.rows[0], {
    purpose: 'temporary',
    media_kind: 'audio',
    status: 'ready',
    expired: true,
  });
  const segmentFiles = await pool.query(
    `SELECT file_id
     FROM media_processing_segments
     WHERE user_id = $1 AND request_id = $2
     ORDER BY sequence_number`,
    [firstUser, videoRequest.id],
  );
  assert.equal(segmentFiles.rowCount, 2);
  const cleanedSegmentIds = [];
  for (let index = 0; index < 2; index += 1) {
    const cleanup = await cleanupNextExpiredObject(pool, store);
    assert.equal(cleanup.deleted, true);
    cleanedSegmentIds.push(cleanup.fileId);
  }
  assert.deepEqual(
    cleanedSegmentIds.sort(),
    segmentFiles.rows.map((row) => row.file_id).sort(),
  );

  const cancellationRequest = await createMediaProcessingRequest(pool, {
    userId: secondUser,
    sourceFileId: secondUserImage.id,
    idempotencyKey: 'cancel-image-analysis',
  });
  const cancellationJob = await ensureNextMediaProcessingJob(pool);
  assert.ok(cancellationJob);
  await requestMediaProcessingCancellation(
    pool,
    secondUser,
    cancellationRequest.id,
  );
  const cancelledJob = await processNextCancellation(pool);
  assert.equal(cancelledJob.jobId, cancellationJob);
  assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  assert.equal(
    (
      await getUserMediaProcessingRequest(
        pool,
        secondUser,
        cancellationRequest.id,
      )
    ).status,
    'cancelled',
  );

  const sourceStates = await pool.query(
    `SELECT id, status, purpose
     FROM files WHERE id = ANY($1::uuid[])`,
    [[image.id, audio.id, video.id, secondUserImage.id]],
  );
  assert.equal(
    sourceStates.rows.every(
      (row) => row.status === 'ready' && row.purpose === 'source',
    ),
    true,
  );
  const billing = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM ledger_entries
        WHERE user_id = ANY($1::uuid[])) AS ledger_count,
       (SELECT COALESCE(sum(actual_cost_micros), 0)::text FROM jobs
        WHERE user_id = ANY($1::uuid[])
          AND type IN ('ai.image', 'ai.transcription', 'ai.text'))
         AS actual_cost`,
    [[firstUser, secondUser]],
  );
  assert.deepEqual(billing.rows[0], {
    ledger_count: 0,
    actual_cost: '0',
  });

  const managedCatalog = {
    zhipuVisionPerImageMicros: 1_200_000n,
    zhipuAsrPerMinuteMicros: 1_200_000n,
    deepseekInputPerMillionTokensMicros: 2_000_000n,
    deepseekOutputPerMillionTokensMicros: 4_000_000n,
  };
  await creditBalance(
    pool,
    secondUser,
    10_000_000n,
    'managed-media-test-credit',
  );
  const managedHandlers = createMediaProcessingHandlers(
    pool,
    store,
    new MockMediaProcessingProvider(),
    {
      stageCostMicros(stage) {
        if (stage === 'image_analyze') return 700_000n;
        if (stage === 'video_transcribe') return 500_000n;
        if (stage === 'video_analyze') return 100_000n;
        return 0n;
      },
    },
  );

  const managedImage = await createManagedMediaProcessingRequest(
    pool,
    {
      userId: secondUser,
      sourceFileId: secondUserImage.id,
      idempotencyKey: 'managed-image-envelope',
    },
    managedCatalog,
  );
  assert.equal(managedImage.request.status, 'awaiting_confirmation');
  assert.equal(managedImage.request.estimatedCostMicros, '1200000');
  assert.equal(managedImage.quote.confirmationRequired, true);
  assert.equal(managedImage.quote.confirmedAt, null);
  assert.equal(await ensureNextMediaProcessingJob(pool), null);
  await confirmAndReserveManagedJobQuote(
    pool,
    secondUser,
    managedImage.quote.jobId,
  );
  const managedImageJob = await ensureNextMediaProcessingJob(pool);
  assert.ok(managedImageJob);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT type, estimated_cost_micros, reserved_cost_micros,
                quote_expires_at
         FROM jobs WHERE id = $1`,
        [managedImageJob],
      )
    ).rows[0],
    {
      type: 'media.image.analyze',
      estimated_cost_micros: '0',
      reserved_cost_micros: '0',
      quote_expires_at: null,
    },
  );
  await runNextJob(pool, 'managed-image-worker', managedHandlers, {
    retryBaseMs: 0,
  });
  assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  assert.equal(
    (
      await getUserMediaProcessingRequest(
        pool,
        secondUser,
        managedImage.request.id,
      )
    ).status,
    'settling',
  );
  assert.match(await ensureNextMediaProcessingJob(pool), /^finalized:/);
  const completedManagedImage = await getUserMediaProcessingRequest(
    pool,
    secondUser,
    managedImage.request.id,
  );
  assert.equal(completedManagedImage.status, 'succeeded');
  assert.equal(completedManagedImage.actualCostMicros, '700000');

  const managedVideo = await createManagedMediaProcessingRequest(
    pool,
    {
      userId: secondUser,
      sourceFileId: secondUserVideo.id,
      idempotencyKey: 'managed-video-envelope',
      durationSeconds: 60,
    },
    managedCatalog,
  );
  assert.equal(managedVideo.quote.confirmationRequired, true);
  await confirmAndReserveManagedJobQuote(
    pool,
    secondUser,
    managedVideo.quote.jobId,
  );
  const managedVideoTypes = [];
  for (let index = 0; index < 3; index += 1) {
    const jobId = await ensureNextMediaProcessingJob(pool);
    assert.ok(jobId);
    const internal = (
      await pool.query(
        `SELECT type, estimated_cost_micros, reserved_cost_micros,
                quote_expires_at
         FROM jobs WHERE id = $1`,
        [jobId],
      )
    ).rows[0];
    managedVideoTypes.push(internal.type);
    assert.equal(internal.estimated_cost_micros, '0');
    assert.equal(internal.reserved_cost_micros, '0');
    assert.equal(internal.quote_expires_at, null);
    await runNextJob(
      pool,
      `managed-video-worker-${index}`,
      managedHandlers,
      { retryBaseMs: 0 },
    );
    assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  }
  assert.deepEqual(managedVideoTypes, [
    'media.video.prepare',
    'media.video.transcribe',
    'media.video.analyze',
  ]);
  assert.match(await ensureNextMediaProcessingJob(pool), /^finalized:/);
  const completedManagedVideo = await getUserMediaProcessingRequest(
    pool,
    secondUser,
    managedVideo.request.id,
  );
  assert.equal(completedManagedVideo.status, 'succeeded');
  assert.equal(completedManagedVideo.actualCostMicros, '600000');

  const cancelledManaged = await createManagedMediaProcessingRequest(
    pool,
    {
      userId: secondUser,
      sourceFileId: secondUserImage.id,
      idempotencyKey: 'managed-cancel-release',
    },
    managedCatalog,
  );
  await confirmAndReserveManagedJobQuote(
    pool,
    secondUser,
    cancelledManaged.quote.jobId,
  );
  const cancelledManagedJob = await ensureNextMediaProcessingJob(pool);
  assert.ok(cancelledManagedJob);
  await requestMediaProcessingCancellation(
    pool,
    secondUser,
    cancelledManaged.request.id,
  );
  assert.equal(
    (await processNextCancellation(pool)).jobId,
    cancelledManagedJob,
  );
  assert.match(await ensureNextMediaProcessingJob(pool), /^reconciled:/);
  assert.match(await ensureNextMediaProcessingJob(pool), /^finalized:/);
  assert.equal(
    (
      await getUserMediaProcessingRequest(
        pool,
        secondUser,
        cancelledManaged.request.id,
      )
    ).status,
    'cancelled',
  );

  const managedAccount = await getBillingAccount(pool, secondUser);
  assert.equal(managedAccount.balanceMicros, '8700000');
  assert.equal(managedAccount.reservedMicros, '0');
  const envelopeLedger = await pool.query(
    `SELECT job_id, kind, amount_micros
     FROM ledger_entries
     WHERE user_id = $1 AND job_id IS NOT NULL
     ORDER BY created_at, id`,
    [secondUser],
  );
  assert.equal(
    envelopeLedger.rows.filter((row) => row.kind === 'reserve').length,
    3,
  );
  assert.equal(
    envelopeLedger.rows.filter((row) => row.kind === 'settle').length,
    2,
  );
  assert.equal(
    new Set(envelopeLedger.rows.map((row) => row.job_id)).size,
    3,
  );

  console.log(
    'media processing smoke test passed: BYOK execution plus managed one-confirmation envelopes, multi-stage cost accumulation, final settlement, cancellation release, tenant isolation, retries, and temporary cleanup',
  );
} finally {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}

async function createUser() {
  const user = await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = user.rows[0].id;
  await pool.query('INSERT INTO billing_accounts (user_id) VALUES ($1)', [userId]);
  return userId;
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

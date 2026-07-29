import assert from 'node:assert/strict';

import pg from 'pg';

import { LocalAesGcmCredentialCipher } from '../dist/credential-cipher.js';
import {
  processNextCancellation,
  runNextJob,
} from '../dist/jobs.js';
import {
  createWechatPollHandler,
  ensureNextWechatPollJob,
  saveWechatConnection,
} from '../dist/wechat-connections.js';

const databaseUrl = process.env.REMIND_BILLING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('REMIND_BILLING_TEST_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });
const cipher = new LocalAesGcmCredentialCipher(
  'wechat-test-v1',
  new Map([['wechat-test-v1', Buffer.alloc(32, 19)]]),
);
const tokenA = 'wechat-token-user-a-private';
const tokenB = 'wechat-token-user-b-private';
const replacementToken = 'wechat-token-user-a-replaced';
const replies = [];
const pollCalls = new Map();
const protocol = {
  async getUpdates(credentials, cursor) {
    if (credentials.botToken === replacementToken) {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: `${cursor}:replacement-cursor`,
      };
    }
    const calls = (pollCalls.get(credentials.botToken) ?? 0) + 1;
    pollCalls.set(credentials.botToken, calls);
    if (credentials.botToken === tokenA && calls === 1) {
      throw new Error('temporary_wechat_outage');
    }
    if (credentials.botToken === tokenA) {
      const duplicate = {
        message_id: 101,
        message_type: 1,
        from_user_id: 'wechat-user-a',
        create_time_ms: 1_700_000_000_000,
        context_token: 'context-a',
        item_list: [
          {
            type: 1,
            text_item: {
              text: '下周阅读 https://example.com/wechat-link',
            },
          },
        ],
      };
      return {
        ret: 0,
        msgs: [
          duplicate,
          duplicate,
          {
            message_id: 102,
            message_type: 1,
            from_user_id: 'not-user-a',
            item_list: [{ type: 1, text_item: { text: '不可保存' } }],
          },
        ],
        get_updates_buf: `${cursor}:cursor-a`,
        longpolling_timeout_ms: 45_000,
      };
    }
    return {
      ret: 0,
      msgs: [
        {
          client_id: 'voice-b-1',
          message_type: 1,
          from_user_id: 'wechat-user-b',
          create_time_ms: 1_700_000_100_000,
          context_token: 'context-b',
          item_list: [{ type: 3, voice_item: { text: 'B 的语音记录' } }],
        },
      ],
      get_updates_buf: `${cursor}:cursor-b`,
    };
  },
  async sendText(credentials, _incoming, text, idempotencyKey) {
    replies.push({
      token: credentials.botToken,
      text,
      idempotencyKey,
    });
  },
};

try {
  const firstUser = await createUser();
  const secondUser = await createUser();
  const firstConnection = await saveWechatConnection(
    pool,
    cipher,
    firstUser,
    {
      botToken: tokenA,
      botId: 'bot-a',
      allowedUserId: 'wechat-user-a',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    },
    'first',
  );
  const secondConnection = await saveWechatConnection(
    pool,
    cipher,
    secondUser,
    {
      botToken: tokenB,
      botId: 'bot-b',
      allowedUserId: 'wechat-user-b',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    },
    'always',
  );

  assert.ok(await ensureNextWechatPollJob(pool));
  assert.ok(await ensureNextWechatPollJob(pool));
  assert.equal(await ensureNextWechatPollJob(pool), null);

  const handlers = new Map([
    ['wechat.poll', createWechatPollHandler(pool, cipher, protocol)],
  ]);
  await runNextJob(pool, 'wechat-worker', handlers, { retryBaseMs: 0 });
  const failedPoll = await pool.query(
    `SELECT cursor, failure_count, last_error_code
     FROM wechat_connections WHERE user_id = $1 AND id = $2`,
    [firstUser, firstConnection],
  );
  assert.equal(failedPoll.rows[0].cursor, '');
  assert.equal(failedPoll.rows[0].failure_count, 1);
  assert.equal(failedPoll.rows[0].last_error_code, 'temporary_wechat_outage');

  assert.equal(
    await runNextJob(pool, 'wechat-worker', handlers, { retryBaseMs: 0 }),
    true,
  );
  assert.equal(
    await runNextJob(pool, 'wechat-worker', handlers, { retryBaseMs: 0 }),
    true,
  );
  assert.equal(
    await runNextJob(pool, 'wechat-worker', handlers, { retryBaseMs: 0 }),
    false,
  );

  const notes = await pool.query(
    `SELECT id, user_id, content, content_kind, source_url, link_status
     FROM notes WHERE source = 'wechat' ORDER BY user_id`,
  );
  assert.equal(notes.rowCount, 2);
  assert.equal(
    notes.rows.filter((row) => row.user_id === firstUser).length,
    1,
  );
  assert.equal(
    notes.rows.filter((row) => row.user_id === secondUser).length,
    1,
  );
  assert.equal(
    notes.rows.some((row) => row.content === '不可保存'),
    false,
  );
  const firstLinkNote = notes.rows.find((row) => row.user_id === firstUser);
  assert.equal(firstLinkNote.content_kind, 'mixed');
  assert.equal(firstLinkNote.source_url, 'https://example.com/wechat-link');
  assert.equal(firstLinkNote.link_status, 'pending');

  const messages = await pool.query(
    `SELECT user_id, connection_id, external_id, type, reply_sent_at
     FROM wechat_messages ORDER BY user_id`,
  );
  assert.equal(messages.rowCount, 2);
  assert.equal(
    messages.rows.find((row) => row.user_id === firstUser).type,
    'text',
  );
  assert.equal(
    messages.rows.find((row) => row.user_id === secondUser).type,
    'voice',
  );
  assert.equal(messages.rows.every((row) => row.reply_sent_at), true);
  assert.equal(replies.length, 2);
  assert.equal(
    new Set(replies.map((reply) => reply.idempotencyKey)).size,
    2,
  );

  const connections = await pool.query(
    `SELECT id, user_id, cursor, failure_count, polling_timeout_ms,
            encrypted_credentials, encryption_key_version
     FROM wechat_connections ORDER BY user_id`,
  );
  assert.equal(connections.rows.every((row) => row.failure_count === 0), true);
  assert.equal(
    connections.rows.find((row) => row.id === firstConnection).polling_timeout_ms,
    45_000,
  );
  for (const row of connections.rows) {
    const serializedCiphertext = row.encrypted_credentials.toString('utf8');
    assert.equal(serializedCiphertext.includes(tokenA), false);
    assert.equal(serializedCiphertext.includes(tokenB), false);
  }
  const firstEncrypted = connections.rows.find(
    (row) => row.id === firstConnection,
  );
  assert.throws(() =>
    cipher.decrypt(
      {
        ciphertext: firstEncrypted.encrypted_credentials,
        keyVersion: firstEncrypted.encryption_key_version,
      },
      {
        userId: secondUser,
        provider: `wechat-ilink:${firstConnection}`,
      },
    ),
  );

  const jobs = await pool.query(
    `SELECT user_id, input_json, status
     FROM jobs WHERE type = 'wechat.poll' ORDER BY user_id`,
  );
  assert.equal(jobs.rowCount, 2);
  assert.equal(jobs.rows.every((row) => row.status === 'succeeded'), true);
  const serializedInputs = JSON.stringify(jobs.rows);
  assert.equal(serializedInputs.includes(tokenA), false);
  assert.equal(serializedInputs.includes(tokenB), false);
  assert.equal(serializedInputs.includes('wechat-user-a'), false);
  assert.equal(serializedInputs.includes('wechat-user-b'), false);
  assert.equal(
    jobs.rows.every(
      (row) =>
        typeof row.input_json.connectionId === 'string' &&
        typeof row.input_json.generation === 'string',
    ),
    true,
  );

  const crossTenant = await pool.query(
    `SELECT count(*)::int AS count
     FROM wechat_messages
     WHERE user_id = $1 AND connection_id = $2`,
    [firstUser, secondConnection],
  );
  assert.equal(crossTenant.rows[0].count, 0);

  await pool.query(
    `UPDATE wechat_connections
     SET next_poll_at = now() + interval '1 hour'
     WHERE user_id = $1 AND id = $2`,
    [secondUser, secondConnection],
  );
  const supersededJob = await ensureNextWechatPollJob(pool);
  assert.ok(supersededJob);
  await saveWechatConnection(
    pool,
    cipher,
    firstUser,
    {
      botToken: replacementToken,
      botId: 'bot-a-replaced',
      allowedUserId: 'wechat-user-a',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    },
    'first',
  );
  const superseded = await pool.query(
    `SELECT cancel_requested_at
     FROM jobs WHERE user_id = $1 AND id = $2`,
    [firstUser, supersededJob],
  );
  assert.ok(superseded.rows[0].cancel_requested_at);
  const replacementJob = await ensureNextWechatPollJob(pool);
  assert.ok(replacementJob);
  await processNextCancellation(pool);
  assert.equal(
    await runNextJob(pool, 'wechat-worker', handlers, { retryBaseMs: 0 }),
    true,
  );
  const repairedConnection = await pool.query(
    `SELECT cursor FROM wechat_connections
     WHERE user_id = $1 AND id = $2`,
    [firstUser, firstConnection],
  );
  assert.equal(repairedConnection.rows[0].cursor, ':replacement-cursor');
  const replacedJobs = await pool.query(
    `SELECT id, status, input_json
     FROM jobs
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[supersededJob, replacementJob]],
  );
  assert.equal(
    replacedJobs.rows.find((row) => row.id === supersededJob).status,
    'cancelled',
  );
  assert.equal(
    replacedJobs.rows.find((row) => row.id === replacementJob).status,
    'succeeded',
  );
  assert.equal(
    JSON.stringify(replacedJobs.rows).includes(replacementToken),
    false,
  );
  await pool.query(
    `UPDATE notes SET link_status = 'failed', link_error_code = 'test_complete'
     WHERE user_id = $1 AND id = $2`,
    [firstUser, firstLinkNote.id],
  );

  console.log(
    'WeChat polling smoke test passed: encrypted credentials, secret-free jobs, per-user isolation, sender filtering, idempotent capture/reply, cursor safety, retry recovery, and safe credential replacement',
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

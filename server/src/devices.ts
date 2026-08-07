import { randomBindingCode, randomSecret, sha256Hex } from './crypto';
import {
  isCancelLinkIntent,
  isMeaningfulLinkContext,
  parseLinkInput,
} from './link';
import type { InboxMessage } from './types';

const BINDING_TTL_MS = 30 * 60 * 1000;

export type ReplyMode = 'first' | 'always' | 'silent';

export async function createDevice(db: D1Database) {
  const now = new Date();
  const deviceId = crypto.randomUUID();
  const deviceSecret = randomSecret();
  const secretHash = await sha256Hex(deviceSecret);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bindingCode = randomBindingCode();
    const expiresAt = new Date(now.getTime() + BINDING_TTL_MS).toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO devices
            (device_id, secret_hash, binding_code, binding_expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          deviceId,
          secretHash,
          bindingCode,
          expiresAt,
          now.toISOString(),
          now.toISOString(),
        )
        .run();
      return { deviceId, deviceSecret, bindingCode, expiresAt };
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }

  throw new Error('Unable to allocate binding code');
}

export async function authenticateDevice(
  db: D1Database,
  deviceId: string,
  authorization: string | null,
): Promise<boolean> {
  const secret = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!secret) return false;
  const secretHash = await sha256Hex(secret);
  const device = await db
    .prepare(
      `SELECT device_id FROM devices
       WHERE device_id = ? AND secret_hash = ?`,
    )
    .bind(deviceId, secretHash)
    .first();
  if (!device) return false;
  await db
    .prepare(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`)
    .bind(new Date().toISOString(), deviceId)
    .run();
  return true;
}

export async function deviceStatus(db: D1Database, deviceId: string) {
  const row = await db
    .prepare(
      `SELECT d.binding_code, d.binding_expires_at, wb.open_id, c.reply_mode,
              c.runtime_status_json, c.runtime_reported_at
       FROM devices d
       LEFT JOIN wechat_bindings wb ON wb.device_id = d.device_id
       LEFT JOIN connectors c ON c.device_id = d.device_id
       WHERE d.device_id = ?`,
    )
    .bind(deviceId)
    .first<{
      binding_code: string;
      binding_expires_at: string;
      open_id: string | null;
      reply_mode: ReplyMode | null;
      runtime_status_json: string | null;
      runtime_reported_at: string | null;
    }>();

  let runtimeStatus: {
    localWhisperAvailable?: boolean;
  } = {};
  try {
    runtimeStatus = row?.runtime_status_json
      ? (JSON.parse(row.runtime_status_json) as typeof runtimeStatus)
      : {};
  } catch {
    runtimeStatus = {};
  }
  const runtimeReportedAt = row?.runtime_reported_at ?? null;
  const gatewayOnline =
    runtimeReportedAt !== null &&
    Date.now() - Date.parse(runtimeReportedAt) < 45_000;
  return row
    ? {
        bound: Boolean(row.open_id),
        bindingCode: row.binding_code,
        expiresAt: row.binding_expires_at,
        replyMode: row.reply_mode ?? 'first',
        gatewayOnline,
        localWhisperAvailable:
          gatewayOnline && runtimeStatus.localWhisperAvailable === true,
      }
    : null;
}

export async function updateConnectorRuntimeStatus(
  db: D1Database,
  connectorId: string,
  status: {
    localWhisperAvailable: boolean;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE connectors
       SET runtime_status_json = ?,
           runtime_reported_at = ?,
           last_seen_at = ?
       WHERE connector_id = ?`,
    )
    .bind(JSON.stringify(status), now, now, connectorId)
    .run();
  return result.meta.changes > 0;
}

export async function updateDeviceReplyMode(
  db: D1Database,
  deviceId: string,
  replyMode: ReplyMode,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE connectors
       SET reply_mode = ?
       WHERE device_id = ?`,
    )
    .bind(replyMode, deviceId)
    .run();
  return result.meta.changes > 0;
}

export async function refreshBindingCode(
  db: D1Database,
  deviceId: string,
) {
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bindingCode = randomBindingCode();
    const expiresAt = new Date(now.getTime() + BINDING_TTL_MS).toISOString();
    try {
      const result = await db
        .prepare(
          `UPDATE devices
           SET binding_code = ?, binding_expires_at = ?
           WHERE device_id = ?`,
        )
        .bind(bindingCode, expiresAt, deviceId)
        .run();
      return result.meta.changes
        ? { bindingCode, expiresAt }
        : null;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  throw new Error('Unable to refresh binding code');
}

export async function bindWechatOpenId(
  db: D1Database,
  openId: string,
  bindingCode: string,
): Promise<boolean> {
  const device = await db
    .prepare(
      `SELECT device_id FROM devices
       WHERE binding_code = ? AND binding_expires_at > ?`,
    )
    .bind(bindingCode, new Date().toISOString())
    .first<{ device_id: string }>();
  if (!device) return false;

  await db
    .prepare(
      `INSERT INTO wechat_bindings (open_id, device_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(open_id) DO UPDATE SET
         device_id = excluded.device_id,
         created_at = excluded.created_at`,
    )
    .bind(openId, device.device_id, new Date().toISOString())
    .run();
  return true;
}

export async function createConnector(
  db: D1Database,
  bindingCode: string,
  kind: string,
) {
  const now = new Date().toISOString();
  const device = await db
    .prepare(
      `SELECT device_id FROM devices
       WHERE binding_code = ? AND binding_expires_at > ?`,
    )
    .bind(bindingCode, now)
    .first<{ device_id: string }>();
  if (!device) return null;

  const connectorId = crypto.randomUUID();
  const connectorSecret = randomSecret();
  const secretHash = await sha256Hex(connectorSecret);
  const syntheticOpenId = `connector:${connectorId}`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO connectors
          (connector_id, device_id, kind, secret_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(connectorId, device.device_id, kind, secretHash, now, now),
    db
      .prepare(
        `INSERT INTO wechat_bindings (open_id, device_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(syntheticOpenId, device.device_id, now),
    db
      .prepare(
        `UPDATE devices SET binding_expires_at = ? WHERE device_id = ?`,
      )
      .bind(now, device.device_id),
  ]);

  return { connectorId, connectorSecret, kind };
}

export async function authenticateConnector(
  db: D1Database,
  connectorId: string,
  authorization: string | null,
): Promise<boolean> {
  const secret = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!secret) return false;
  const secretHash = await sha256Hex(secret);
  const connector = await db
    .prepare(
      `SELECT connector_id FROM connectors
       WHERE connector_id = ? AND secret_hash = ?`,
    )
    .bind(connectorId, secretHash)
    .first();
  if (!connector) return false;
  await db
    .prepare(
      `UPDATE connectors SET last_seen_at = ? WHERE connector_id = ?`,
    )
    .bind(new Date().toISOString(), connectorId)
    .run();
  return true;
}

export async function captureConnectorMessage(
  db: D1Database,
  connectorId: string,
  externalId: string,
  type: string,
  content: string,
  createdAt: string,
): Promise<{
  inserted: boolean;
  replyMode: ReplyMode;
  shouldReply: boolean;
  replyText: string | null;
  linkSnapshot?: {
    messageId: string;
    url: string;
    userContext: string;
  };
}> {
  const connector = await db
    .prepare(
      `SELECT reply_mode, confirmation_sent_at
       FROM connectors
       WHERE connector_id = ?`,
    )
    .bind(connectorId)
    .first<{
      reply_mode: ReplyMode;
      confirmation_sent_at: string | null;
    }>();
  if (!connector) throw new Error('Connector not found');

  const claimed = await db
    .prepare(
      `INSERT INTO connector_events (connector_id, external_id, processed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(connector_id, external_id) DO NOTHING`,
    )
    .bind(connectorId, externalId, new Date().toISOString())
    .run();
  if (claimed.meta.changes === 0) {
    return {
      inserted: false,
      replyMode: connector.reply_mode,
      shouldReply: false,
      replyText: null,
    };
  }

  const msgId = `connector:${connectorId}:${externalId}`;
  const openId = `connector:${connectorId}`;
  const sourceCreatedAt = Math.floor(
    (Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : Date.now()) /
      1000,
  );
  const pending = await db
    .prepare(
      `SELECT msg_id, link_url
       FROM wechat_messages
       WHERE open_id = ? AND intent_status = 'pending'
       ORDER BY received_at ASC
       LIMIT 1`,
    )
    .bind(openId)
    .first<{ msg_id: string; link_url: string }>();
  const parsedLink = parseLinkInput(content);

  if (pending && !parsedLink) {
    if (isCancelLinkIntent(content)) {
      await db
        .prepare(
          `UPDATE wechat_messages
           SET intent_status = 'cancelled'
           WHERE msg_id = ?`,
        )
        .bind(pending.msg_id)
        .run();
      return {
        inserted: false,
        replyMode: connector.reply_mode,
        shouldReply: true,
        replyText: '已取消这条链接。你可以继续发送其他记录。',
      };
    }
    if (!isMeaningfulLinkContext(content)) {
      return {
        inserted: false,
        replyMode: connector.reply_mode,
        shouldReply: true,
        replyText:
          '请再具体一点：用一句话说说为什么保存，或者希望 ReMind 重点整理什么。',
      };
    }
    const combinedContent = `${pending.link_url}\n\n${content.trim()}`;
    await db.batch([
      db
        .prepare(
          `UPDATE wechat_messages
           SET intent_status = 'cancelled'
           WHERE msg_id = ?`,
        )
        .bind(pending.msg_id),
      db
        .prepare(
          `INSERT INTO wechat_messages
            (msg_id, open_id, msg_type, content, link_url, user_context,
             intent_status, page_status, source_created_at, received_at)
           VALUES (?, ?, 'link', ?, ?, ?, 'ready', 'pending', ?, ?)`,
        )
        .bind(
          msgId,
          openId,
          combinedContent,
          pending.link_url,
          content.trim(),
          sourceCreatedAt,
          new Date().toISOString(),
        ),
    ]);
    const shouldReply = await claimConfirmationIfNeeded(
      db,
      connectorId,
      connector,
    );
    return {
      inserted: true,
      replyMode: connector.reply_mode,
      shouldReply,
      replyText: shouldReply
        ? '描述已收到。ReMind 会把链接整理成一篇可审核笔记。'
        : null,
      linkSnapshot: {
        messageId: msgId,
        url: pending.link_url,
        userContext: content.trim(),
      },
    };
  }

  if (parsedLink) {
    if (parsedLink.urlCount > 1) {
      return {
        inserted: false,
        replyMode: connector.reply_mode,
        shouldReply: true,
        replyText: '为了准确整理，请一次只发送一个链接。',
      };
    }
    if (pending && !isMeaningfulLinkContext(parsedLink.userContext)) {
      return {
        inserted: false,
        replyMode: connector.reply_mode,
        shouldReply: true,
        replyText:
          '上一条链接还在等待描述。请先补一句说明，或回复“取消”。',
      };
    }
    const ready = isMeaningfulLinkContext(parsedLink.userContext);
    const inserted = await db
      .prepare(
        `INSERT INTO wechat_messages
          (msg_id, open_id, msg_type, content, link_url, user_context,
           intent_status, page_status, source_created_at, received_at)
         VALUES (?, ?, 'link', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        msgId,
        openId,
        content,
        parsedLink.url,
        ready ? parsedLink.userContext : null,
        ready ? 'ready' : 'pending',
        ready ? 'pending' : 'none',
        sourceCreatedAt,
        new Date().toISOString(),
      )
      .run();
    if (!ready) {
      return {
        inserted: inserted.meta.changes > 0,
        replyMode: connector.reply_mode,
        shouldReply: true,
        replyText:
          '链接已收到。请再用一句话告诉我：你为什么保存它，或者希望我重点整理什么？回复“取消”可以放弃。',
      };
    }
    const shouldReply = await claimConfirmationIfNeeded(
      db,
      connectorId,
      connector,
    );
    return {
      inserted: inserted.meta.changes > 0,
      replyMode: connector.reply_mode,
      shouldReply,
      replyText: shouldReply
        ? 'ReMind 已收到链接和描述，会生成一篇可审核笔记。'
        : null,
      linkSnapshot: {
        messageId: msgId,
        url: parsedLink.url,
        userContext: parsedLink.userContext,
      },
    };
  }

  const inserted = await db
    .prepare(
      `INSERT INTO wechat_messages
        (msg_id, open_id, msg_type, content, source_created_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(msg_id) DO NOTHING`,
    )
    .bind(
      msgId,
      openId,
      type,
      content,
      sourceCreatedAt,
      new Date().toISOString(),
    )
    .run();
  const wasInserted = inserted.meta.changes > 0;
  const shouldReply =
    wasInserted &&
    (await claimConfirmationIfNeeded(db, connectorId, connector));

  return {
    inserted: wasInserted,
    replyMode: connector.reply_mode,
    shouldReply,
    replyText: shouldReply
      ? wasInserted
        ? 'ReMind 已记下。'
        : '这条内容之前已经记过了。'
      : null,
  };
}

export async function saveConnectorLinkSnapshot(
  db: D1Database,
  connectorId: string,
  messageId: string,
  snapshot:
    | {
      status: 'ready';
      title: string;
      site: string;
      text: string;
      images: string[];
      visualText: string | null;
      visualModel: string | null;
      mediaType: 'web' | 'image' | 'video';
      durationSeconds: number | null;
      }
    | { status: 'failed' },
): Promise<boolean> {
  const openId = `connector:${connectorId}`;
  const result =
    snapshot.status === 'ready'
      ? await db
          .prepare(
            `UPDATE wechat_messages
             SET page_title = ?, page_site = ?, page_text = ?,
                 page_images_json = ?, page_visual_text = ?,
                 page_visual_model = ?,
                 page_media_type = ?, page_duration_seconds = ?,
                 page_processing_stage = 'complete',
                 page_progress_current = page_progress_total,
                 page_error_code = NULL, page_updated_at = ?,
                 page_status = 'ready'
             WHERE msg_id = ? AND open_id = ?
               AND page_status IN ('none', 'pending', 'failed')`,
          )
          .bind(
            snapshot.title.slice(0, 300),
            snapshot.site.slice(0, 200),
            snapshot.text.slice(0, 24_000),
            JSON.stringify(snapshot.images.slice(0, 12)),
            snapshot.visualText?.slice(0, 12_000) ?? null,
            snapshot.visualModel?.slice(0, 100) ?? null,
            snapshot.mediaType,
            snapshot.durationSeconds,
            new Date().toISOString(),
            messageId,
            openId,
          )
          .run()
      : await db
          .prepare(
            `UPDATE wechat_messages
             SET page_status = 'failed'
                 , page_processing_stage = 'failed'
                 , page_error_code = 'processing_failed'
                 , page_updated_at = ?
             WHERE msg_id = ? AND open_id = ?
               AND page_status IN ('none', 'pending')`,
          )
          .bind(new Date().toISOString(), messageId, openId)
          .run();
  return result.meta.changes > 0;
}

export async function updateConnectorLinkProgress(
  db: D1Database,
  connectorId: string,
  messageId: string,
  progress: {
    stage: 'queued' | 'extracting' | 'transcribing' | 'awaiting_approval';
    current: number;
    total: number;
    provider: string | null;
    estimatedCostMicros: number | null;
    durationSeconds: number | null;
    costLimitMicros: number | null;
  },
): Promise<boolean> {
  const openId = `connector:${connectorId}`;
  const result = await db
    .prepare(
      `UPDATE wechat_messages
       SET page_status = 'pending',
           page_media_type = 'video',
           page_duration_seconds = COALESCE(?, page_duration_seconds),
           page_processing_stage = ?,
           page_progress_current = ?,
           page_progress_total = ?,
           page_transcription_provider = ?,
           page_estimated_cost_micros = ?,
           page_cloud_cost_limit_micros = ?,
           page_error_code = NULL,
           page_updated_at = ?
       WHERE msg_id = ? AND open_id = ?
         AND intent_status = 'ready'
         AND page_status IN ('pending', 'failed')`,
    )
    .bind(
      progress.durationSeconds,
      progress.stage,
      progress.current,
      progress.total,
      progress.provider,
      progress.estimatedCostMicros,
      progress.costLimitMicros,
      new Date().toISOString(),
      messageId,
      openId,
    )
    .run();
  return result.meta.changes > 0;
}

export async function listDeviceProcessingLinks(
  db: D1Database,
  deviceId: string,
): Promise<Array<{
  messageId: string;
  title: string;
  url: string;
  stage: string;
  status: 'pending' | 'failed';
  current: number;
  total: number;
  provider: string | null;
  estimatedCostMicros: number | null;
  durationSeconds: number | null;
  errorCode: string | null;
  cloudCostApproved: boolean;
  costLimitMicros: number | null;
  updatedAt: string;
}>> {
  const result = await db
    .prepare(
      `SELECT wm.msg_id, wm.content, wm.page_title, wm.link_url,
              wm.page_processing_stage, wm.page_status,
              wm.page_progress_current, wm.page_progress_total,
              wm.page_transcription_provider, wm.page_estimated_cost_micros,
              wm.page_duration_seconds, wm.page_error_code,
              wm.page_cloud_cost_approved, wm.page_cloud_cost_limit_micros,
              COALESCE(wm.page_updated_at, wm.received_at) AS progress_updated_at
       FROM wechat_messages wm
       INNER JOIN wechat_bindings wb ON wb.open_id = wm.open_id
       WHERE wb.device_id = ?
         AND wm.intent_status = 'ready'
         AND wm.page_status IN ('pending', 'failed')
       ORDER BY wm.received_at DESC
       LIMIT 20`,
    )
    .bind(deviceId)
    .all<{
      msg_id: string;
      content: string;
      page_title: string | null;
      link_url: string;
      page_processing_stage: string | null;
      page_status: 'pending' | 'failed';
      page_progress_current: number;
      page_progress_total: number;
      page_transcription_provider: string | null;
      page_estimated_cost_micros: number | null;
      page_duration_seconds: number | null;
      page_error_code: string | null;
      page_cloud_cost_approved: number;
      page_cloud_cost_limit_micros: number | null;
      progress_updated_at: string;
    }>();
  return result.results.map((row) => ({
    messageId: row.msg_id,
    title:
      row.page_title?.trim() ||
      row.content.split(/\r?\n/)[0].replace(/https?:\/\/\S+/g, '').trim() ||
      '视频链接',
    url: row.link_url,
    stage: row.page_processing_stage ?? 'queued',
    status: row.page_status,
    current: row.page_progress_current,
    total: row.page_progress_total,
    provider: row.page_transcription_provider,
    estimatedCostMicros: row.page_estimated_cost_micros,
    durationSeconds: row.page_duration_seconds,
    errorCode: row.page_error_code,
    cloudCostApproved: row.page_cloud_cost_approved === 1,
    costLimitMicros: row.page_cloud_cost_limit_micros,
    updatedAt: row.progress_updated_at,
  }));
}

export async function approveDeviceLinkCloudCost(
  db: D1Database,
  deviceId: string,
  messageId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE wechat_messages
       SET page_cloud_cost_approved = 1,
           page_processing_stage = 'queued',
           page_error_code = NULL,
           page_updated_at = ?
       WHERE msg_id = ?
         AND page_status = 'pending'
         AND page_processing_stage = 'awaiting_approval'
         AND open_id IN (
           SELECT open_id FROM wechat_bindings WHERE device_id = ?
         )`,
    )
    .bind(new Date().toISOString(), messageId, deviceId)
    .run();
  return result.meta.changes > 0;
}

export async function retryDeviceProcessingLink(
  db: D1Database,
  deviceId: string,
  messageId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE wechat_messages
       SET page_status = 'pending',
           page_processing_stage = 'queued',
           page_progress_current = 0,
           page_progress_total = 0,
           page_error_code = NULL,
           page_updated_at = ?
       WHERE msg_id = ?
         AND page_status = 'failed'
         AND open_id IN (
           SELECT open_id FROM wechat_bindings WHERE device_id = ?
         )`,
    )
    .bind(new Date().toISOString(), messageId, deviceId)
    .run();
  return result.meta.changes > 0;
}

export async function listPendingConnectorLinkSnapshots(
  db: D1Database,
  connectorId: string,
): Promise<Array<{
  messageId: string;
  url: string;
  userContext: string;
  cloudCostApproved: boolean;
}>> {
  const openId = `connector:${connectorId}`;
  const result = await db
    .prepare(
      `SELECT msg_id, link_url, user_context, page_cloud_cost_approved
       FROM wechat_messages
       WHERE open_id = ?
         AND intent_status = 'ready'
         AND page_status = 'pending'
         AND (
           page_processing_stage IS NULL
           OR page_processing_stage != 'awaiting_approval'
           OR page_cloud_cost_approved = 1
         )
         AND link_url IS NOT NULL
         AND user_context IS NOT NULL
       ORDER BY received_at ASC
       LIMIT 10`,
    )
    .bind(openId)
    .all<{
      msg_id: string;
      link_url: string;
      user_context: string;
      page_cloud_cost_approved: number;
    }>();
  return result.results.map((row) => ({
    messageId: row.msg_id,
    url: row.link_url,
    userContext: row.user_context,
    cloudCostApproved: row.page_cloud_cost_approved === 1,
  }));
}

async function claimConfirmationIfNeeded(
  db: D1Database,
  connectorId: string,
  connector: {
    reply_mode: ReplyMode;
    confirmation_sent_at: string | null;
  },
): Promise<boolean> {
  if (connector.reply_mode === 'always') return true;
  if (
    connector.reply_mode !== 'first' ||
    connector.confirmation_sent_at !== null
  ) {
    return false;
  }
  const claimed = await db
    .prepare(
      `UPDATE connectors
       SET confirmation_sent_at = ?
       WHERE connector_id = ? AND confirmation_sent_at IS NULL`,
    )
    .bind(new Date().toISOString(), connectorId)
    .run();
  return claimed.meta.changes > 0;
}

export async function isWechatBound(
  db: D1Database,
  openId: string,
): Promise<boolean> {
  return Boolean(
    await db
      .prepare(`SELECT open_id FROM wechat_bindings WHERE open_id = ?`)
      .bind(openId)
      .first(),
  );
}

export async function listInbox(
  db: D1Database,
  deviceId: string,
): Promise<InboxMessage[]> {
  const result = await db
    .prepare(
      `SELECT wm.msg_id, wm.msg_type, wm.content, wm.link_url,
              wm.user_context, wm.page_title, wm.page_site, wm.page_text,
              wm.received_at
       FROM wechat_messages wm
       INNER JOIN wechat_bindings wb ON wb.open_id = wm.open_id
       LEFT JOIN device_acknowledgements da
         ON da.msg_id = wm.msg_id AND da.device_id = wb.device_id
       WHERE wb.device_id = ?
         AND da.msg_id IS NULL
         AND wm.intent_status IN ('not_required', 'ready')
         AND wm.page_status != 'pending'
       ORDER BY wm.received_at ASC
       LIMIT 100`,
    )
    .bind(deviceId)
    .all<{
      msg_id: string;
      msg_type: string;
      content: string;
      link_url: string | null;
      user_context: string | null;
      page_title: string | null;
      page_site: string | null;
      page_text: string | null;
      received_at: string;
    }>();

  return result.results.map((row) => ({
    msgId: row.msg_id,
    type: row.msg_type,
    content: row.content,
    linkUrl: row.link_url,
    userContext: row.user_context,
    pageTitle: row.page_title,
    pageSite: row.page_site,
    pageText: row.page_text,
    createdAt: row.received_at,
  }));
}

export async function findDeviceLinkSnapshot(
  db: D1Database,
  deviceId: string,
  linkUrl: string,
): Promise<{
  title: string;
  site: string;
  text: string;
  images: string[];
  visualText: string | null;
  visualModel: string | null;
  mediaType: 'web' | 'image' | 'video';
  durationSeconds: number | null;
} | null> {
  const row = await db
    .prepare(
      `SELECT wm.page_title, wm.page_site, wm.page_text,
              wm.page_images_json, wm.page_visual_text, wm.page_visual_model,
              wm.page_media_type, wm.page_duration_seconds
       FROM wechat_messages wm
       INNER JOIN wechat_bindings wb ON wb.open_id = wm.open_id
       WHERE wb.device_id = ?
         AND wm.link_url = ?
         AND wm.page_status = 'ready'
         AND wm.page_title IS NOT NULL
         AND wm.page_site IS NOT NULL
         AND wm.page_text IS NOT NULL
       ORDER BY wm.received_at DESC
       LIMIT 1`,
    )
    .bind(deviceId, linkUrl)
    .first<{
      page_title: string;
      page_site: string;
      page_text: string;
      page_images_json: string;
      page_visual_text: string | null;
      page_visual_model: string | null;
      page_media_type: 'web' | 'image' | 'video';
      page_duration_seconds: number | null;
    }>();

  return row
    ? {
        title: row.page_title,
        site: row.page_site,
        text: row.page_text,
        images: parseStoredStringArray(row.page_images_json),
        visualText: row.page_visual_text,
        visualModel: row.page_visual_model,
        mediaType: row.page_media_type,
        durationSeconds: row.page_duration_seconds,
      }
    : null;
}

function parseStoredStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function acknowledgeInbox(
  db: D1Database,
  deviceId: string,
  messageIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  const statements = messageIds.slice(0, 100).map((messageId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO device_acknowledgements
          (device_id, msg_id, acknowledged_at)
         VALUES (?, ?, ?)`,
      )
      .bind(deviceId, messageId, now),
  );
  if (statements.length) await db.batch(statements);
}

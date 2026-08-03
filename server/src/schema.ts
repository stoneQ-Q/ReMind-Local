let schemaReady: Promise<void> | undefined;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = createSchema(db).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

async function createSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY NOT NULL,
        secret_hash TEXT NOT NULL,
        binding_code TEXT NOT NULL UNIQUE,
        binding_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS wechat_bindings (
        open_id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS wechat_messages (
        msg_id TEXT PRIMARY KEY NOT NULL,
        open_id TEXT NOT NULL,
        msg_type TEXT NOT NULL,
        content TEXT NOT NULL,
        link_url TEXT,
        user_context TEXT,
        intent_status TEXT NOT NULL DEFAULT 'not_required'
          CHECK (intent_status IN ('not_required', 'pending', 'ready', 'cancelled')),
        page_title TEXT,
        page_site TEXT,
        page_text TEXT,
        page_images_json TEXT NOT NULL DEFAULT '[]',
        page_visual_text TEXT,
        page_visual_model TEXT,
        page_media_type TEXT NOT NULL DEFAULT 'web'
          CHECK (page_media_type IN ('web', 'image', 'video')),
        page_duration_seconds INTEGER,
        page_processing_stage TEXT,
        page_progress_current INTEGER NOT NULL DEFAULT 0,
        page_progress_total INTEGER NOT NULL DEFAULT 0,
        page_transcription_provider TEXT,
        page_estimated_cost_micros INTEGER,
        page_error_code TEXT,
        page_updated_at TEXT,
        page_cloud_cost_approved INTEGER NOT NULL DEFAULT 0,
        page_cloud_cost_limit_micros INTEGER,
        page_status TEXT NOT NULL DEFAULT 'none'
          CHECK (page_status IN ('none', 'pending', 'ready', 'failed')),
        source_created_at INTEGER NOT NULL,
        received_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS device_acknowledgements (
        device_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL,
        PRIMARY KEY (device_id, msg_id),
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
        FOREIGN KEY (msg_id) REFERENCES wechat_messages(msg_id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS callback_diagnostics (
        id TEXT PRIMARY KEY NOT NULL,
        method TEXT NOT NULL,
        signature_valid INTEGER NOT NULL,
        msg_type TEXT,
        stage TEXT NOT NULL,
        received_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS connectors (
        connector_id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        reply_mode TEXT NOT NULL DEFAULT 'first'
          CHECK (reply_mode IN ('first', 'always', 'silent')),
        confirmation_sent_at TEXT,
        runtime_status_json TEXT,
        runtime_reported_at TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS connector_events (
        connector_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (connector_id, external_id),
        FOREIGN KEY (connector_id) REFERENCES connectors(connector_id) ON DELETE CASCADE
      )
    `),
  ]);

  await db.batch([
    db.prepare(`
      CREATE INDEX IF NOT EXISTS wechat_bindings_device_idx
      ON wechat_bindings(device_id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS wechat_messages_open_id_received_idx
      ON wechat_messages(open_id, received_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS callback_diagnostics_received_idx
      ON callback_diagnostics(received_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS connectors_device_idx
      ON connectors(device_id)
    `),
  ]);
}

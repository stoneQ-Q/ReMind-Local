PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY NOT NULL,
  secret_hash TEXT NOT NULL,
  binding_code TEXT NOT NULL UNIQUE,
  binding_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wechat_bindings (
  open_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wechat_bindings_device_idx
ON wechat_bindings(device_id);

CREATE TABLE IF NOT EXISTS wechat_messages (
  msg_id TEXT PRIMARY KEY NOT NULL,
  open_id TEXT NOT NULL,
  msg_type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_created_at INTEGER NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS wechat_messages_open_id_received_idx
ON wechat_messages(open_id, received_at);

CREATE TABLE IF NOT EXISTS device_acknowledgements (
  device_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (device_id, msg_id),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
  FOREIGN KEY (msg_id) REFERENCES wechat_messages(msg_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connectors (
  connector_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS connectors_device_idx
ON connectors(device_id);

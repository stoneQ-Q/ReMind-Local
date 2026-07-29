ALTER TABLE wechat_messages
ADD COLUMN link_url TEXT;

ALTER TABLE wechat_messages
ADD COLUMN user_context TEXT;

ALTER TABLE wechat_messages
ADD COLUMN intent_status TEXT NOT NULL DEFAULT 'not_required'
CHECK (intent_status IN ('not_required', 'pending', 'ready', 'cancelled'));

CREATE TABLE IF NOT EXISTS connector_events (
  connector_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, external_id),
  FOREIGN KEY (connector_id) REFERENCES connectors(connector_id) ON DELETE CASCADE
);


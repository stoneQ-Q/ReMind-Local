CREATE TABLE IF NOT EXISTS callback_diagnostics (
  id TEXT PRIMARY KEY NOT NULL,
  method TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  msg_type TEXT,
  stage TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS callback_diagnostics_received_idx
ON callback_diagnostics(received_at);

ALTER TABLE connectors
ADD COLUMN runtime_status_json TEXT;

ALTER TABLE connectors
ADD COLUMN runtime_reported_at TEXT;

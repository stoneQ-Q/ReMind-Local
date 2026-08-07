ALTER TABLE connectors
ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'first'
CHECK (reply_mode IN ('first', 'always', 'silent'));

ALTER TABLE connectors
ADD COLUMN confirmation_sent_at TEXT;

UPDATE connectors
SET confirmation_sent_at = created_at
WHERE confirmation_sent_at IS NULL;

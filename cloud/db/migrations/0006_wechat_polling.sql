ALTER TABLE wechat_connections
  ADD COLUMN cursor TEXT NOT NULL DEFAULT '',
  ADD COLUMN polling_timeout_ms INTEGER NOT NULL DEFAULT 40000
    CHECK (polling_timeout_ms BETWEEN 5000 AND 120000),
  ADD COLUMN next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (failure_count >= 0),
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN poll_generation BIGINT NOT NULL DEFAULT 0
    CHECK (poll_generation >= 0),
  ADD COLUMN poll_job_id UUID,
  ADD CONSTRAINT wechat_connections_poll_job_owner_fk
    FOREIGN KEY (user_id, poll_job_id)
    REFERENCES jobs(user_id, id) ON DELETE SET NULL (poll_job_id);

CREATE UNIQUE INDEX wechat_connections_active_user_idx
  ON wechat_connections(user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE wechat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  note_id UUID NOT NULL,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  content TEXT NOT NULL,
  source_created_at TIMESTAMPTZ NOT NULL,
  reply_required BOOLEAN NOT NULL DEFAULT false,
  reply_sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, connection_id)
    REFERENCES wechat_connections(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, note_id)
    REFERENCES notes(user_id, id) ON DELETE RESTRICT,
  UNIQUE (user_id, id),
  UNIQUE (connection_id, external_id)
);

CREATE INDEX wechat_connections_poll_due_idx
  ON wechat_connections(next_poll_at, created_at)
  WHERE status = 'active' AND revoked_at IS NULL;

CREATE INDEX wechat_messages_user_received_idx
  ON wechat_messages(user_id, received_at DESC, id);

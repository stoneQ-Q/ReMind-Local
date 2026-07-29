CREATE TABLE recovery_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX recovery_credentials_active_user_idx
  ON recovery_credentials(user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE user_sessions
  ADD COLUMN device_id UUID;

ALTER TABLE user_sessions
  ADD CONSTRAINT user_sessions_device_owner_fk
  FOREIGN KEY (user_id, device_id)
  REFERENCES devices(user_id, id)
  ON DELETE CASCADE;

ALTER TABLE user_sessions
  ALTER COLUMN device_id SET NOT NULL;

CREATE INDEX user_sessions_device_idx
  ON user_sessions(user_id, device_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE wechat_binding_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX wechat_binding_codes_active_user_idx
  ON wechat_binding_codes(user_id)
  WHERE claimed_at IS NULL;

CREATE INDEX wechat_binding_codes_expiry_idx
  ON wechat_binding_codes(expires_at)
  WHERE claimed_at IS NULL;

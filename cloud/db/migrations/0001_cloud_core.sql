CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE ai_usage_mode AS ENUM (
  'disabled',
  'bring_your_own_key',
  'managed'
);

CREATE TYPE job_status AS ENUM (
  'queued',
  'reserved',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

CREATE TYPE ledger_entry_kind AS ENUM (
  'top_up',
  'reserve',
  'settle',
  'release',
  'refund',
  'adjustment'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleting')),
  ai_mode ai_usage_mode NOT NULL DEFAULT 'disabled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, id)
);

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  display_name TEXT,
  platform TEXT NOT NULL
    CHECK (platform IN ('android', 'ios', 'unknown')),
  app_version TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE wechat_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'expired', 'revoked', 'failed')),
  provider_subject_hash TEXT,
  encrypted_credentials BYTEA,
  encryption_key_version TEXT,
  reply_mode TEXT NOT NULL DEFAULT 'first'
    CHECK (reply_mode IN ('first', 'always', 'silent')),
  last_polled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX wechat_connections_provider_subject_idx
  ON wechat_connections(provider_subject_hash)
  WHERE provider_subject_hash IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  summary TEXT,
  source TEXT NOT NULL,
  record_type TEXT NOT NULL,
  content_kind TEXT NOT NULL,
  source_url TEXT,
  sync_version BIGINT NOT NULL DEFAULT 1 CHECK (sync_version > 0),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, client_id)
);

CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256_hex TEXT,
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_key BYTEA NOT NULL,
  encryption_key_version TEXT NOT NULL,
  masked_suffix TEXT NOT NULL CHECK (char_length(masked_suffix) <= 8),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX api_credentials_active_provider_idx
  ON api_credentials(user_id, provider)
  WHERE revoked_at IS NULL;

CREATE TABLE billing_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  balance_micros BIGINT NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
  reserved_micros BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_micros >= 0 AND reserved_micros <= balance_micros),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  idempotency_key TEXT NOT NULL,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  error_code TEXT,
  estimated_cost_micros BIGINT NOT NULL DEFAULT 0
    CHECK (estimated_cost_micros >= 0),
  reserved_cost_micros BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_cost_micros >= 0),
  actual_cost_micros BIGINT
    CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  billing_account_id UUID NOT NULL,
  job_id UUID,
  kind ledger_entry_kind NOT NULL,
  amount_micros BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, billing_account_id)
    REFERENCES billing_accounts(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, job_id)
    REFERENCES jobs(user_id, id) ON DELETE RESTRICT,
  UNIQUE (user_id, id),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX user_sessions_active_idx
  ON user_sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX devices_user_active_idx
  ON devices(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX notes_user_updated_idx
  ON notes(user_id, updated_at DESC);

CREATE INDEX jobs_worker_queue_idx
  ON jobs(status, available_at, created_at)
  WHERE status IN ('queued', 'reserved');

CREATE INDEX jobs_user_created_idx
  ON jobs(user_id, created_at DESC);

CREATE INDEX ledger_entries_account_created_idx
  ON ledger_entries(billing_account_id, created_at, id);

CREATE OR REPLACE FUNCTION reject_ledger_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are append-only';
END;
$$;

CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_mutation();

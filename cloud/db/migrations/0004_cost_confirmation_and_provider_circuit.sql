ALTER TABLE billing_policy
  ADD COLUMN high_cost_confirmation_threshold_micros BIGINT NOT NULL
    DEFAULT 1000000
    CHECK (
      high_cost_confirmation_threshold_micros > 0
      AND high_cost_confirmation_threshold_micros <= max_job_cost_micros
    ),
  ADD COLUMN provider_failure_threshold INTEGER NOT NULL DEFAULT 3
    CHECK (provider_failure_threshold BETWEEN 2 AND 100),
  ADD COLUMN provider_failure_window_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (provider_failure_window_seconds BETWEEN 30 AND 86400);

ALTER TABLE jobs
  ADD COLUMN provider TEXT,
  ADD COLUMN confirmation_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN quote_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT jobs_confirmation_state_valid CHECK (
    NOT confirmation_required
    OR quote_expires_at IS NOT NULL
  );

CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  failure_window_started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  pause_reason TEXT,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO provider_health (provider)
VALUES ('deepseek'), ('zhipu');

CREATE TABLE operational_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('provider_auto_paused')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  provider TEXT NOT NULL REFERENCES provider_health(provider) ON DELETE RESTRICT,
  message TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX operational_alerts_open_created_idx
  ON operational_alerts(created_at, id)
  WHERE acknowledged_at IS NULL;

CREATE INDEX jobs_user_quote_idx
  ON jobs(user_id, created_at DESC)
  WHERE quote_expires_at IS NOT NULL;

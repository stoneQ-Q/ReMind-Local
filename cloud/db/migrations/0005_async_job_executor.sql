ALTER TABLE jobs
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3
    CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (timeout_seconds BETWEEN 1 AND 14400),
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN worker_id TEXT,
  ADD COLUMN last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN cancel_requested_at TIMESTAMPTZ,
  ADD CONSTRAINT jobs_running_lease_required CHECK (
    status <> 'running'
    OR (
      lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND worker_id IS NOT NULL
    )
  );

CREATE TABLE job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  job_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  lease_token UUID NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (
      status IN (
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'timed_out',
        'lease_expired'
      )
    ),
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (user_id, job_id)
    REFERENCES jobs(user_id, id) ON DELETE RESTRICT,
  UNIQUE (user_id, job_id, attempt_number)
);

CREATE TABLE worker_user_fairness (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claimable_idx
  ON jobs(available_at, created_at)
  WHERE status IN ('queued', 'reserved')
    AND cancel_requested_at IS NULL;

CREATE INDEX jobs_expired_lease_idx
  ON jobs(lease_expires_at)
  WHERE status = 'running';

CREATE INDEX jobs_cancellation_idx
  ON jobs(cancel_requested_at, created_at)
  WHERE status IN ('queued', 'reserved', 'running')
    AND cancel_requested_at IS NOT NULL;

CREATE INDEX job_attempts_job_started_idx
  ON job_attempts(user_id, job_id, started_at, id);

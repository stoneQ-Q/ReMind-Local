ALTER TABLE media_processing_requests
  DROP CONSTRAINT media_processing_requests_status_check,
  ADD CONSTRAINT media_processing_requests_status_check CHECK (
    status IN (
      'awaiting_confirmation',
      'pending',
      'processing',
      'settling',
      'releasing',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  ADD COLUMN execution_mode ai_usage_mode NOT NULL
    DEFAULT 'bring_your_own_key',
  ADD COLUMN billing_job_id UUID,
  ADD COLUMN duration_seconds INTEGER
    CHECK (duration_seconds BETWEEN 1 AND 21600),
  ADD COLUMN estimated_cost_micros BIGINT NOT NULL DEFAULT 0
    CHECK (estimated_cost_micros >= 0),
  ADD COLUMN actual_cost_micros BIGINT NOT NULL DEFAULT 0
    CHECK (
      actual_cost_micros >= 0
      AND actual_cost_micros <= estimated_cost_micros
    ),
  ADD COLUMN terminal_status TEXT
    CHECK (terminal_status IN ('failed', 'cancelled')),
  ADD CONSTRAINT media_processing_billing_job_fk
    FOREIGN KEY (user_id, billing_job_id)
    REFERENCES jobs(user_id, id) ON DELETE SET NULL (billing_job_id),
  ADD CONSTRAINT media_processing_execution_mode_valid CHECK (
    execution_mode IN ('bring_your_own_key', 'managed')
  ),
  ADD CONSTRAINT media_processing_billing_envelope_valid CHECK (
    (
      execution_mode = 'bring_your_own_key'
      AND billing_job_id IS NULL
      AND estimated_cost_micros = 0
      AND actual_cost_micros = 0
    )
    OR (
      execution_mode = 'managed'
      AND estimated_cost_micros > 0
    )
  );

DROP INDEX media_processing_pending_idx;

CREATE INDEX media_processing_pending_idx
  ON media_processing_requests(status, created_at, id)
  WHERE status IN (
    'awaiting_confirmation',
    'pending',
    'processing',
    'settling',
    'releasing'
  );

CREATE UNIQUE INDEX media_processing_billing_job_unique_idx
  ON media_processing_requests(user_id, billing_job_id)
  WHERE billing_job_id IS NOT NULL;

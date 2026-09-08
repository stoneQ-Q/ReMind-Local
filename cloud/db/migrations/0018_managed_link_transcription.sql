ALTER TABLE xiaoyuzhou_transcriptions
  RENAME TO link_transcriptions;

ALTER INDEX xiaoyuzhou_transcriptions_provider_task_idx
  RENAME TO link_transcriptions_provider_task_idx;

ALTER TABLE link_transcriptions
  ADD COLUMN media_type TEXT NOT NULL DEFAULT 'audio'
    CHECK (media_type IN ('audio', 'video')),
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'dashscope'
    CHECK (provider IN ('dashscope', 'whisper')),
  ADD COLUMN billing_job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
  ADD COLUMN estimated_duration_seconds INTEGER
    CHECK (
      estimated_duration_seconds IS NULL
      OR estimated_duration_seconds BETWEEN 1 AND 43200
    ),
  ADD COLUMN billable_duration_seconds INTEGER
    CHECK (
      billable_duration_seconds IS NULL
      OR billable_duration_seconds BETWEEN 1 AND 43200
    );

CREATE UNIQUE INDEX link_transcriptions_billing_job_idx
  ON link_transcriptions(billing_job_id)
  WHERE billing_job_id IS NOT NULL;

INSERT INTO provider_health (provider)
VALUES ('dashscope')
ON CONFLICT (provider) DO NOTHING;

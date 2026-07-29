CREATE TABLE media_processing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  source_file_id UUID NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'audio', 'video')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  stage TEXT NOT NULL
    CHECK (
      stage IN (
        'image_analyze',
        'audio_transcribe',
        'video_prepare',
        'video_transcribe',
        'video_analyze'
      )
    ),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  current_job_id UUID,
  intermediate_file_id UUID,
  transcript TEXT,
  result_json JSONB,
  error_code TEXT,
  cancel_requested_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, source_file_id)
    REFERENCES files(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, current_job_id)
    REFERENCES jobs(user_id, id) ON DELETE SET NULL (current_job_id),
  FOREIGN KEY (user_id, intermediate_file_id)
    REFERENCES files(user_id, id) ON DELETE SET NULL (intermediate_file_id),
  UNIQUE (user_id, id),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX media_processing_pending_idx
  ON media_processing_requests(status, created_at, id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX media_processing_user_created_idx
  ON media_processing_requests(user_id, created_at DESC, id);

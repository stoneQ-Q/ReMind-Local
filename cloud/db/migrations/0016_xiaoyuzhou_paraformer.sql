CREATE TABLE xiaoyuzhou_transcriptions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL,
  link_generation BIGINT NOT NULL CHECK (link_generation > 0),
  provider_task_id TEXT NOT NULL CHECK (length(provider_task_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'succeeded', 'failed')),
  transcript TEXT,
  segments_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(segments_json) = 'array'),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, note_id, link_generation),
  FOREIGN KEY (user_id, note_id)
    REFERENCES notes(user_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX xiaoyuzhou_transcriptions_provider_task_idx
  ON xiaoyuzhou_transcriptions(provider_task_id);

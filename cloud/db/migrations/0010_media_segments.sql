CREATE TABLE media_processing_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  file_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, request_id)
    REFERENCES media_processing_requests(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, file_id)
    REFERENCES files(user_id, id) ON DELETE RESTRICT,
  UNIQUE (user_id, request_id, sequence_number),
  UNIQUE (user_id, file_id)
);

CREATE INDEX media_processing_segments_request_idx
  ON media_processing_segments(user_id, request_id, sequence_number);

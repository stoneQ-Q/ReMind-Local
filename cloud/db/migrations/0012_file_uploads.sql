CREATE TABLE file_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'proxy_chunks'
    CHECK (strategy IN ('proxy_chunks', 'provider_multipart')),
  provider_upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'uploading',
        'completing',
        'cancelling',
        'succeeded',
        'failed',
        'cancelled'
      )
    ),
  expected_size_bytes BIGINT NOT NULL
    CHECK (expected_size_bytes > 0 AND expected_size_bytes <= 1073741824),
  uploaded_size_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (
      uploaded_size_bytes >= 0
      AND uploaded_size_bytes <= expected_size_bytes
    ),
  expected_sha256_hex TEXT NOT NULL
    CHECK (expected_sha256_hex ~ '^[a-f0-9]{64}$'),
  chunk_size_bytes INTEGER NOT NULL DEFAULT 4194304
    CHECK (chunk_size_bytes BETWEEN 262144 AND 8388608),
  expires_at TIMESTAMPTZ NOT NULL,
  error_code TEXT,
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (cleanup_attempt_count >= 0),
  cleanup_lease_token UUID,
  cleanup_lease_expires_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, file_id)
    REFERENCES files(user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, id),
  UNIQUE (user_id, file_id),
  UNIQUE (user_id, idempotency_key),
  CHECK (
    (cleanup_lease_token IS NULL AND cleanup_lease_expires_at IS NULL)
    OR
    (cleanup_lease_token IS NOT NULL AND cleanup_lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX file_uploads_active_expiry_idx
  ON file_uploads(expires_at, created_at, id)
  WHERE status IN ('pending', 'uploading', 'completing', 'cancelling');

CREATE INDEX file_uploads_user_created_idx
  ON file_uploads(user_id, created_at DESC, id);

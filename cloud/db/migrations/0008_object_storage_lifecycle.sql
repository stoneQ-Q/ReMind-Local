ALTER TABLE files
  ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'
    CHECK (storage_provider IN ('local', 'tencent_cos', 'aliyun_oss')),
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'source'
    CHECK (purpose IN ('source', 'temporary', 'result')),
  ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'document'
    CHECK (media_kind IN ('image', 'audio', 'video', 'document')),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('pending', 'ready', 'deleting', 'deleted', 'failed')),
  ADD COLUMN original_name TEXT,
  ADD COLUMN last_accessed_at TIMESTAMPTZ,
  ADD COLUMN deletion_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (deletion_attempt_count >= 0),
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN cleanup_lease_token UUID,
  ADD COLUMN cleanup_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT files_size_limit CHECK (size_bytes <= 1073741824),
  ADD CONSTRAINT files_sha256_format CHECK (
    sha256_hex IS NULL OR sha256_hex ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT files_tenant_object_key CHECK (
    object_key LIKE 'users/' || user_id::text || '/%'
    AND object_key !~ '(^|/)\.\.?(/|$)'
    AND length(object_key) <= 512
  ),
  ADD CONSTRAINT files_temporary_expiry CHECK (
    purpose <> 'temporary' OR expires_at IS NOT NULL
  ),
  ADD CONSTRAINT files_cleanup_lease_state CHECK (
    (cleanup_lease_token IS NULL AND cleanup_lease_expires_at IS NULL)
    OR
    (cleanup_lease_token IS NOT NULL AND cleanup_lease_expires_at IS NOT NULL)
  );

CREATE TABLE file_deletion_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  file_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  lease_token UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (user_id, file_id)
    REFERENCES files(user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, file_id, attempt_number)
);

CREATE INDEX files_cleanup_due_idx
  ON files(expires_at, created_at, id)
  WHERE purpose = 'temporary'
    AND status IN ('ready', 'deleting')
    AND deleted_at IS NULL;

CREATE INDEX files_stale_pending_idx
  ON files(created_at, id)
  WHERE status = 'pending' AND deleted_at IS NULL;

CREATE INDEX files_user_status_idx
  ON files(user_id, status, created_at DESC, id);

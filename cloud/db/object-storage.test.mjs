import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./migrations/0008_object_storage_lifecycle.sql', import.meta.url),
  'utf8',
);

describe('object storage lifecycle migration', () => {
  it('keeps provider-neutral metadata and tenant-prefixed object keys', () => {
    expect(migration).toContain(
      "storage_provider IN ('local', 'tencent_cos', 'aliyun_oss')",
    );
    expect(migration).toContain(
      "object_key LIKE 'users/' || user_id::text || '/%'",
    );
    expect(migration).toContain('files_size_limit');
    expect(migration).toContain('files_sha256_format');
  });

  it('uses recoverable cleanup leases with durable attempt history', () => {
    expect(migration).toContain('cleanup_lease_token UUID');
    expect(migration).toContain('cleanup_lease_expires_at TIMESTAMPTZ');
    expect(migration).toContain('CREATE TABLE file_deletion_attempts');
    expect(migration).toContain('files_cleanup_due_idx');
    expect(migration).toContain('files_stale_pending_idx');
    expect(migration).toContain('files_temporary_expiry');
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./migrations/0006_wechat_polling.sql', import.meta.url),
  'utf8',
);

describe('WeChat cloud polling migration', () => {
  it('keeps polling state and ownership on each user connection', () => {
    expect(migration).toContain('poll_generation BIGINT NOT NULL');
    expect(migration).toContain('poll_job_id UUID');
    expect(migration).toContain(
      'FOREIGN KEY (user_id, poll_job_id)',
    );
    expect(migration).toContain('ON DELETE SET NULL (poll_job_id)');
    expect(migration).toContain('wechat_connections_active_user_idx');
  });

  it('deduplicates inbound messages without mixing tenants', () => {
    expect(migration).toContain('CREATE TABLE wechat_messages');
    expect(migration).toContain('user_id UUID NOT NULL');
    expect(migration).toContain('UNIQUE (connection_id, external_id)');
    expect(migration).toContain(
      'FOREIGN KEY (user_id, connection_id)',
    );
    expect(migration).toContain('FOREIGN KEY (user_id, note_id)');
  });
});

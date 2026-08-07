import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./migrations/0007_link_processing.sql', import.meta.url),
  'utf8',
);
const xiaoyuzhouMigration = readFileSync(
  new URL(
    './migrations/0015_xiaoyuzhou_audio_processing.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('link processing migration', () => {
  it('stores bounded link results on the user-owned note', () => {
    expect(migration).toContain('source_page_title TEXT');
    expect(migration).toContain('source_page_text TEXT');
    expect(migration).toContain('link_platform TEXT');
    expect(migration).toContain('link_media_type TEXT');
    expect(migration).toContain('link_images_json JSONB');
    expect(migration).toContain('link_duration_seconds BETWEEN 1 AND 21600');
  });

  it('fences each processing job by owner and generation', () => {
    expect(migration).toContain('link_generation BIGINT NOT NULL');
    expect(migration).toContain('link_job_id UUID');
    expect(migration).toContain('FOREIGN KEY (user_id, link_job_id)');
    expect(migration).toContain('ON DELETE SET NULL (link_job_id)');
    expect(migration).toContain('notes_link_processing_idx');
  });

  it('adds Xiaoyuzhou audio without weakening the existing link boundary', () => {
    expect(xiaoyuzhouMigration).toContain(
      "link_platform IN ('web', 'xiaohongshu', 'xiaoyuzhou')",
    );
    expect(xiaoyuzhouMigration).toContain(
      "link_media_type IN ('web', 'image', 'video', 'audio')",
    );
    expect(xiaoyuzhouMigration).toContain('notes_link_media_processing_idx');
  });
});

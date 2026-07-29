ALTER TABLE notes
  ADD COLUMN user_context TEXT,
  ADD COLUMN source_page_title TEXT,
  ADD COLUMN source_page_description TEXT,
  ADD COLUMN source_page_site TEXT,
  ADD COLUMN source_page_text TEXT,
  ADD COLUMN link_platform TEXT
    CHECK (link_platform IN ('web', 'xiaohongshu')),
  ADD COLUMN link_media_type TEXT
    CHECK (link_media_type IN ('web', 'image', 'video')),
  ADD COLUMN link_images_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(link_images_json) = 'array'),
  ADD COLUMN link_duration_seconds INTEGER
    CHECK (
      link_duration_seconds IS NULL
      OR link_duration_seconds BETWEEN 1 AND 21600
    ),
  ADD COLUMN link_status TEXT
    CHECK (link_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN link_error_code TEXT,
  ADD COLUMN link_generation BIGINT NOT NULL DEFAULT 0
    CHECK (link_generation >= 0),
  ADD COLUMN link_job_id UUID,
  ADD CONSTRAINT notes_link_job_owner_fk
    FOREIGN KEY (user_id, link_job_id)
    REFERENCES jobs(user_id, id) ON DELETE SET NULL (link_job_id);

CREATE INDEX notes_link_processing_idx
  ON notes(link_status, created_at, id)
  WHERE deleted_at IS NULL AND source_url IS NOT NULL;

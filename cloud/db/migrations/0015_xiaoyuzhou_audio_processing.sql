ALTER TABLE notes
  DROP CONSTRAINT notes_link_platform_check,
  ADD CONSTRAINT notes_link_platform_check
    CHECK (link_platform IN ('web', 'xiaohongshu', 'xiaoyuzhou')),
  DROP CONSTRAINT notes_link_media_type_check,
  ADD CONSTRAINT notes_link_media_type_check
    CHECK (link_media_type IN ('web', 'image', 'video', 'audio'));

DROP INDEX notes_link_video_media_idx;

CREATE INDEX notes_link_media_processing_idx
  ON notes(link_media_status, created_at, id)
  WHERE deleted_at IS NULL
    AND link_media_type IN ('video', 'audio')
    AND link_source_file_id IS NOT NULL;

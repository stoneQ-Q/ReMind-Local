ALTER TABLE notes
  ADD COLUMN link_source_file_id UUID,
  ADD COLUMN link_media_request_id UUID,
  ADD COLUMN link_media_status TEXT
    CHECK (
      link_media_status IN (
        'awaiting_key', 'pending', 'processing', 'succeeded', 'failed'
      )
    ),
  ADD COLUMN link_media_error_code TEXT,
  ADD CONSTRAINT notes_link_source_file_owner_fk
    FOREIGN KEY (user_id, link_source_file_id)
    REFERENCES files(user_id, id) ON DELETE SET NULL (link_source_file_id),
  ADD CONSTRAINT notes_link_media_request_owner_fk
    FOREIGN KEY (user_id, link_media_request_id)
    REFERENCES media_processing_requests(user_id, id)
    ON DELETE SET NULL (link_media_request_id);

CREATE INDEX notes_link_video_media_idx
  ON notes(link_media_status, created_at, id)
  WHERE deleted_at IS NULL
    AND link_media_type = 'video'
    AND link_source_file_id IS NOT NULL;

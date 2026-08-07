ALTER TABLE wechat_messages
ADD COLUMN page_media_type TEXT NOT NULL DEFAULT 'web'
CHECK (page_media_type IN ('web', 'image', 'video'));

ALTER TABLE wechat_messages
ADD COLUMN page_duration_seconds INTEGER;

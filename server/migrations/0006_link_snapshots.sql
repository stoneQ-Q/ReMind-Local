ALTER TABLE wechat_messages
ADD COLUMN page_title TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_site TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_text TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_status TEXT NOT NULL DEFAULT 'none'
CHECK (page_status IN ('none', 'pending', 'ready', 'failed'));

ALTER TABLE wechat_messages
ADD COLUMN page_images_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE wechat_messages
ADD COLUMN page_visual_text TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_visual_model TEXT;

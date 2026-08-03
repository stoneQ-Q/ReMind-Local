ALTER TABLE wechat_messages
ADD COLUMN page_processing_stage TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_progress_current INTEGER NOT NULL DEFAULT 0;

ALTER TABLE wechat_messages
ADD COLUMN page_progress_total INTEGER NOT NULL DEFAULT 0;

ALTER TABLE wechat_messages
ADD COLUMN page_transcription_provider TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_estimated_cost_micros INTEGER;

ALTER TABLE wechat_messages
ADD COLUMN page_error_code TEXT;

ALTER TABLE wechat_messages
ADD COLUMN page_updated_at TEXT;

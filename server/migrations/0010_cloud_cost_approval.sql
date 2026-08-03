ALTER TABLE wechat_messages
ADD COLUMN page_cloud_cost_approved INTEGER NOT NULL DEFAULT 0;

ALTER TABLE wechat_messages
ADD COLUMN page_cloud_cost_limit_micros INTEGER;

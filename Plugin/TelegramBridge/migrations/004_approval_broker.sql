ALTER TABLE approvals ADD COLUMN parent_message_id TEXT;
ALTER TABLE approvals ADD COLUMN chat_id TEXT;
ALTER TABLE approvals ADD COLUMN thread_id TEXT;
ALTER TABLE approvals ADD COLUMN telegram_message_id TEXT;
ALTER TABLE approvals ADD COLUMN tool_name TEXT;
ALTER TABLE approvals ADD COLUMN acted_at INTEGER
  CHECK (acted_at IS NULL OR acted_at >= 0);

CREATE INDEX idx_approvals_owner_status
  ON approvals(owner_user_id, status, expires_at);

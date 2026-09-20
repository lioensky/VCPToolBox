ALTER TABLE updates ADD COLUMN input_bundle_key TEXT;
CREATE INDEX idx_updates_input_bundle ON updates(input_bundle_key, received_at);
ALTER TABLE attachments ADD COLUMN conversation_id TEXT;
CREATE INDEX idx_attachments_conversation ON attachments(scope_key, conversation_id, created_at);

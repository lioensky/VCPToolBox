-- Human input survives independently of an unconfirmed assistant/tool result.
CREATE TABLE conversation_inputs (
  request_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  user_text TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE CASCADE,
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_conversation_inputs_scope
  ON conversation_inputs(scope_key, conversation_id, owner_user_id, created_at);

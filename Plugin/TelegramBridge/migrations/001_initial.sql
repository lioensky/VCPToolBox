CREATE TABLE scopes (
  scope_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  current_agent TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (chat_id, thread_id, current_agent)
) STRICT;

CREATE UNIQUE INDEX uq_scopes_active_chat_thread
  ON scopes(chat_id, thread_id) WHERE is_active = 1;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL CHECK (turn_seq >= 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
  telegram_message_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_key, conversation_id, turn_id, position),
  UNIQUE (scope_key, conversation_id, turn_seq, position),
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_messages_history
  ON messages(scope_key, conversation_id, turn_seq, position);

CREATE TABLE updates (
  update_id TEXT PRIMARY KEY,
  next_offset TEXT NOT NULL,
  update_type TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error_code TEXT,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  finished_at INTEGER,
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_updates_status_updated ON updates(status, updated_at);

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  update_id TEXT,
  scope_key TEXT,
  retry_of_request_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (update_id) REFERENCES updates(update_id) ON DELETE SET NULL,
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE SET NULL,
  FOREIGN KEY (retry_of_request_id) REFERENCES requests(request_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_requests_scope_status
  ON requests(scope_key, status, updated_at);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  correlation_version INTEGER NOT NULL DEFAULT 1 CHECK (correlation_version = 1),
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_approvals_status_expiry ON approvals(status, expires_at);

CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY,
  scope_key TEXT,
  request_id TEXT,
  telegram_message_id TEXT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  relative_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE SET NULL,
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_attachments_scope_status
  ON attachments(scope_key, status);

CREATE TABLE async_tasks (
  task_key TEXT PRIMARY KEY,
  plugin_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  scope_key TEXT,
  correlation_version INTEGER NOT NULL DEFAULT 1 CHECK (correlation_version = 1),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  completed_at INTEGER,
  UNIQUE (plugin_name, task_id),
  FOREIGN KEY (request_id) REFERENCES requests(request_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_async_tasks_scope_status
  ON async_tasks(scope_key, status, updated_at);

CREATE TABLE deliveries (
  idempotency_key TEXT PRIMARY KEY,
  scope_key TEXT,
  kind TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code TEXT,
  next_attempt_at INTEGER,
  telegram_message_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  delivered_at INTEGER,
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_deliveries_due ON deliveries(status, next_attempt_at);

CREATE TABLE dead_letters (
  dead_letter_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  scope_key TEXT,
  safe_error_code TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (source_type, source_key),
  FOREIGN KEY (scope_key) REFERENCES scopes(scope_key) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_dead_letters_created ON dead_letters(created_at);

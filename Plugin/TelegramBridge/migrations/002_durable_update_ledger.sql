ALTER TABLE updates ADD COLUMN payload_json TEXT
  CHECK (payload_json IS NULL OR json_valid(payload_json));
ALTER TABLE updates ADD COLUMN payload_sha256 TEXT
  CHECK (payload_sha256 IS NULL OR length(payload_sha256) = 64);
ALTER TABLE updates ADD COLUMN ordering_key TEXT;
ALTER TABLE updates ADD COLUMN initial_request_id TEXT
  REFERENCES requests(request_id) ON DELETE SET NULL;

ALTER TABLE requests ADD COLUMN ordering_key TEXT;
ALTER TABLE requests ADD COLUMN owner_user_id TEXT;
ALTER TABLE requests ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'not_started'
  CHECK (effect_state IN ('not_started','started','confirmed','unknown'));
ALTER TABLE requests ADD COLUMN replay_policy TEXT NOT NULL DEFAULT 'manual'
  CHECK (replay_policy IN ('safe','idempotent','manual'));
ALTER TABLE requests ADD COLUMN worker_id TEXT;
ALTER TABLE requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0
  CHECK (attempt >= 0);
ALTER TABLE requests ADD COLUMN claimed_at INTEGER;

CREATE UNIQUE INDEX uq_requests_initial_update
  ON requests(update_id)
  WHERE update_id IS NOT NULL AND retry_of_request_id IS NULL;

CREATE UNIQUE INDEX uq_updates_initial_request
  ON updates(initial_request_id)
  WHERE initial_request_id IS NOT NULL;

CREATE INDEX idx_updates_cursor
  ON updates(length(next_offset), next_offset);

CREATE INDEX idx_requests_ready
  ON requests(status, updated_at, request_id);

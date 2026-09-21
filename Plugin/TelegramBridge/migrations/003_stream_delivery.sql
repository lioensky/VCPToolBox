ALTER TABLE requests ADD COLUMN telegram_draft_id INTEGER
  CHECK (telegram_draft_id IS NULL OR telegram_draft_id > 0);
ALTER TABLE requests ADD COLUMN completion_sha256 TEXT
  CHECK (completion_sha256 IS NULL OR length(completion_sha256) = 64);

ALTER TABLE deliveries ADD COLUMN segment_index INTEGER
  CHECK (segment_index IS NULL OR segment_index >= 0);
ALTER TABLE deliveries ADD COLUMN payload_json TEXT
  CHECK (payload_json IS NULL OR json_valid(payload_json));
ALTER TABLE deliveries ADD COLUMN payload_sha256 TEXT
  CHECK (payload_sha256 IS NULL OR length(payload_sha256) = 64);
ALTER TABLE deliveries ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'not_started'
  CHECK (effect_state IN ('not_started','started','confirmed','unknown'));

CREATE UNIQUE INDEX uq_deliveries_final_segment
  ON deliveries(source_type, source_key, segment_index)
  WHERE source_type = 'telegram_final' AND segment_index IS NOT NULL;

ALTER TABLE updates ADD COLUMN album_parent_update_id TEXT REFERENCES updates(update_id);
CREATE INDEX idx_updates_album_parent ON updates(album_parent_update_id);

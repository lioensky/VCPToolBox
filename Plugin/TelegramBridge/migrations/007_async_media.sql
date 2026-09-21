ALTER TABLE async_tasks ADD COLUMN media_prepared INTEGER NOT NULL DEFAULT 0 CHECK (media_prepared IN (0, 1));

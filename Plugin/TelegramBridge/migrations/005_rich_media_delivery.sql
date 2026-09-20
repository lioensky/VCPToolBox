CREATE UNIQUE INDEX uq_deliveries_rich_media
  ON deliveries(source_type, source_key, segment_index)
  WHERE source_type = 'telegram_rich_media' AND segment_index IS NOT NULL;

-- SDT-G69 F3: promotion may resolve an ordering quarantine only after the
-- candidate has a durable, explicit rebuild proof. Existing generations are
-- intentionally unverified until a complete catch-up records the marker.
ALTER TABLE mv_instances ADD COLUMN rebuild_verified_at INTEGER;

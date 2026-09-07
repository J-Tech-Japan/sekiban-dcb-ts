-- SDT-G67 AC1/AC6 event-driven safe-lane pass provenance.
-- This is observation-only: no safe frontier or Queue decision reads this
-- table.  A row is created before a kick is started and then updated through
-- the pass lifecycle so a missing kick, coalesced request, or failed pass is
-- distinguishable from a completed pass.
CREATE TABLE serialized_dcb_safe_lane_passes (
  service_id TEXT NOT NULL,
  pass_id TEXT NOT NULL COLLATE BINARY,
  trigger TEXT NOT NULL CHECK (trigger IN ('kick', 'cron')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'failed', 'coalesced')),
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  coverage_kind TEXT CHECK (coverage_kind IS NULL OR coverage_kind IN ('SETTLED', 'BLOCK/UNSETTLED')),
  coverage_reason TEXT,
  coverage_partition_tag TEXT COLLATE BINARY,
  settled_frontier_suid TEXT COLLATE BINARY,
  safe_heads_before_json TEXT,
  safe_heads_after_json TEXT,
  error TEXT,
  PRIMARY KEY (service_id, pass_id)
);

CREATE INDEX serialized_dcb_safe_lane_passes_service_scheduled
  ON serialized_dcb_safe_lane_passes (service_id, scheduled_at ASC, pass_id COLLATE BINARY ASC);

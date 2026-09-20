-- SDT-G58 safe-lane operational health. This is intentionally an additive
-- pipeline-D1 migration: the runtime never performs DDL, and the row records
-- the last *scheduled* coverage decision rather than inferring it from a
-- request-time read.
CREATE TABLE serialized_dcb_safe_lane_health (
  service_id TEXT PRIMARY KEY,
  coverage_kind TEXT NOT NULL CHECK (coverage_kind IN ('SETTLED', 'BLOCK/UNSETTLED')),
  coverage_reason TEXT,
  coverage_partition_tag TEXT COLLATE BINARY,
  settled_frontier_suid TEXT NOT NULL COLLATE BINARY DEFAULT '',
  observed_at INTEGER NOT NULL
);

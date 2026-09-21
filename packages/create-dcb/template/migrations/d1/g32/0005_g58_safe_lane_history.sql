-- SDT-G58 AC1 scheduled safe-lane history.  This is append-only evidence of
-- the coverage decision made by each cron tick.  An empty frontier is an
-- explicit record of a tick for which no proven FULL frontier existed; the
-- health guard treats that value as red rather than substituting an MV head.
CREATE TABLE serialized_dcb_safe_lane_history (
  service_id TEXT NOT NULL,
  tick_id TEXT NOT NULL COLLATE BINARY,
  coverage_kind TEXT NOT NULL CHECK (coverage_kind IN ('SETTLED', 'BLOCK/UNSETTLED')),
  coverage_reason TEXT,
  coverage_partition_tag TEXT COLLATE BINARY,
  settled_frontier_suid TEXT NOT NULL COLLATE BINARY DEFAULT '',
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, tick_id),
  UNIQUE (service_id, observed_at)
);

CREATE INDEX serialized_dcb_safe_lane_history_service_observed
  ON serialized_dcb_safe_lane_history (service_id, observed_at ASC, tick_id COLLATE BINARY ASC);

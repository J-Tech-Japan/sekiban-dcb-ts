-- SDT-G67 AC4 durable ownership and effective catch-up attribution.
-- These columns are observation-only.  The G44 frontier and Queue
-- disposition never read this table.
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN delivery_event_id TEXT COLLATE BINARY;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN delivery_attempt_id TEXT COLLATE BINARY;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN delivery_partition_tag TEXT COLLATE BINARY;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN delivery_obligation_sequence INTEGER;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN catch_up_started_at INTEGER;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN catch_up_completed_at INTEGER;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN catch_up_outcome TEXT;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN catch_up_error TEXT;

CREATE INDEX serialized_dcb_safe_lane_passes_delivery_identity
  ON serialized_dcb_safe_lane_passes (
    service_id,
    delivery_partition_tag COLLATE BINARY,
    delivery_obligation_sequence,
    scheduled_at ASC,
    pass_id COLLATE BINARY ASC
  );

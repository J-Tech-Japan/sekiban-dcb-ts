-- SDT-G67 amended AC1 fence-expiry and coverage-retry provenance.
-- These fields are observation-only. They never participate in G44
-- certification, Queue disposition, MV advancement, or public reads.
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN trigger_kind TEXT CHECK (trigger_kind IS NULL OR trigger_kind IN ('delivery', 'fence-expiry', 'coverage-retry', 'cron', 'kick'));
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN stop_deadline_at INTEGER;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN stop_reason TEXT;

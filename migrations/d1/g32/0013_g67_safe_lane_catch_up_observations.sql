-- SDT-G67 AC4 observation-only catch-up result attribution.
-- These columns identify the exact Queue delivery SUID and the observed
-- SafeWindow/MV result.  No safe-lane admission, frontier, or Queue decision
-- reads them.
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN delivery_suid TEXT COLLATE BINARY;
ALTER TABLE serialized_dcb_safe_lane_passes ADD COLUMN catch_up_result_json TEXT;

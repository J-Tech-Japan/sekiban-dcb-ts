SELECT 'dcb_events' AS record_kind, * FROM dcb_events;
SELECT 'global_receipts' AS record_kind, * FROM serialized_dcb_global_receipts;
SELECT 'hop_measurements' AS record_kind, * FROM serialized_dcb_hop_measurements;
SELECT 'hop_submeasurements' AS record_kind, * FROM serialized_dcb_hop_submeasurements;
SELECT 'unsafe_writer_boundaries' AS record_kind, * FROM serialized_dcb_unsafe_writer_boundaries;
SELECT 'live_poll_health' AS record_kind, * FROM serialized_dcb_live_poll_health;
SELECT 'safe_lane_health' AS record_kind, * FROM serialized_dcb_safe_lane_health;
SELECT 'safe_lane_history' AS record_kind, * FROM serialized_dcb_safe_lane_history;

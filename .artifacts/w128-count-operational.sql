SELECT
  (SELECT COUNT(*) FROM dcb_events) AS dcb_events,
  (SELECT COUNT(*) FROM serialized_dcb_global_receipts) AS serialized_dcb_global_receipts,
  (SELECT COUNT(*) FROM serialized_dcb_hop_measurements) AS serialized_dcb_hop_measurements,
  (SELECT COUNT(*) FROM serialized_dcb_hop_submeasurements) AS serialized_dcb_hop_submeasurements,
  (SELECT COUNT(*) FROM serialized_dcb_unsafe_writer_boundaries) AS serialized_dcb_unsafe_writer_boundaries,
  (SELECT COUNT(*) FROM serialized_dcb_live_poll_health) AS serialized_dcb_live_poll_health,
  (SELECT COUNT(*) FROM serialized_dcb_safe_lane_health) AS serialized_dcb_safe_lane_health,
  (SELECT COUNT(*) FROM serialized_dcb_safe_lane_history) AS serialized_dcb_safe_lane_history;

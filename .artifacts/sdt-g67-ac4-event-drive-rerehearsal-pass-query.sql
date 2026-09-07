SELECT service_id, pass_id, trigger, status, scheduled_at, started_at,
  completed_at, coverage_kind, coverage_reason, coverage_partition_tag,
  settled_frontier_suid, safe_heads_before_json, safe_heads_after_json,
  error, delivery_event_id, delivery_attempt_id, delivery_partition_tag,
  delivery_obligation_sequence, catch_up_started_at, catch_up_completed_at,
  catch_up_outcome, catch_up_error
FROM serialized_dcb_safe_lane_passes
WHERE service_id = 'sekiban-dcb-g60-w155-c'
ORDER BY scheduled_at ASC, pass_id COLLATE BINARY ASC;

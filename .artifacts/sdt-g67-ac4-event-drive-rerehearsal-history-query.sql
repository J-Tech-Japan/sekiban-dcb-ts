SELECT service_id, tick_id, coverage_kind, coverage_reason, coverage_partition_tag,
  proven_frontier_suid, observed_at
FROM serialized_dcb_safe_lane_history
WHERE service_id = 'sekiban-dcb-g60-w155-c'
ORDER BY observed_at ASC, tick_id COLLATE BINARY ASC;

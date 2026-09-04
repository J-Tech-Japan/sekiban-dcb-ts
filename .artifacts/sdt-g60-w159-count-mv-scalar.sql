SELECT json_object(
  'mv_instances', (SELECT COUNT(*) FROM mv_instances),
  'mv_active_generations', (SELECT COUNT(*) FROM mv_active_generations),
  'mv_rows', (SELECT COUNT(*) FROM mv_rows),
  'mv_index_entries', (SELECT COUNT(*) FROM mv_index_entries),
  'mv_unsafe_rows', (SELECT COUNT(*) FROM mv_unsafe_rows),
  'mv_unsafe_index_entries', (SELECT COUNT(*) FROM mv_unsafe_index_entries),
  'mv_unsafe_receipts', (SELECT COUNT(*) FROM mv_unsafe_receipts),
  'mv_unsafe_markers', (SELECT COUNT(*) FROM mv_unsafe_markers),
  'mv_unsafe_arrivals', (SELECT COUNT(*) FROM mv_unsafe_arrivals),
  'mv_unsafe_kicks', (SELECT COUNT(*) FROM mv_unsafe_kicks),
  'mv_unsafe_failure_findings', (SELECT COUNT(*) FROM mv_unsafe_failure_findings),
  'mv_wait_receipts', (SELECT COUNT(*) FROM mv_wait_receipts),
  'mv_wait_target_poison', (SELECT COUNT(*) FROM mv_wait_target_poison),
  'mv_checkpoint_ahead_findings', (SELECT COUNT(*) FROM mv_checkpoint_ahead_findings),
  'mv_atomic_guards', (SELECT COUNT(*) FROM mv_atomic_guards)
) AS counts;

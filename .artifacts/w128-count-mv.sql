SELECT 'mv_rows' AS table_name, COUNT(*) AS row_count FROM mv_rows
UNION ALL SELECT 'mv_unsafe_rows', COUNT(*) FROM mv_unsafe_rows
UNION ALL SELECT 'mv_unsafe_receipts', COUNT(*) FROM mv_unsafe_receipts
UNION ALL SELECT 'mv_unsafe_kicks', COUNT(*) FROM mv_unsafe_kicks
UNION ALL SELECT 'mv_wait_receipts', COUNT(*) FROM mv_wait_receipts;

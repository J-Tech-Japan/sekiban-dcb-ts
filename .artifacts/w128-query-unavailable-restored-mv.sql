SELECT event_id, view_id, outcome, COUNT(*) AS row_count
FROM mv_unsafe_receipts
WHERE event_id IN (
  '01a06f4d-23c1-726e-80af-54ff65525826',
  '01a06f4d-5321-7625-bb2c-6301bc2d4ed6',
  '01a06f4d-8251-7270-9bec-670ff16ff4f7'
)
GROUP BY event_id, view_id, outcome;
SELECT service_id, view_id, row_key, row_version, source_suid
FROM mv_rows
WHERE row_key LIKE 'g65-unavailable%';

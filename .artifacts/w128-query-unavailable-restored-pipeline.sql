SELECT Id, SortableUniqueId, Tags, Timestamp FROM dcb_events WHERE Tags LIKE '%g65-unavailable%';
SELECT event_id, COUNT(*) AS receipt_count, GROUP_CONCAT(membership_tag) AS membership_tags
FROM serialized_dcb_global_receipts
WHERE event_id IN (SELECT Id FROM dcb_events WHERE Tags LIKE '%g65-unavailable%')
GROUP BY event_id;
SELECT event_id, stage, COUNT(*) AS row_count
FROM serialized_dcb_hop_measurements
WHERE event_id IN (SELECT Id FROM dcb_events WHERE Tags LIKE '%g65-unavailable%')
GROUP BY event_id, stage;

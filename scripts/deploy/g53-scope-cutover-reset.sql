-- SDT-G53 C-0/C-13 scoped-Durable-Object cutover reset.
--
-- The physical scope grammar intentionally abandoned the pre-G53 allocator
-- and Tag instances. These four global registry/health records describe only
-- that retired namespace and cannot be reconciled through the new grammar.
-- Delivery incidents, wait-target incidents, receipts, and event records are
-- deliberately retained as audit evidence. Run once only against the normal
-- pipeline D1 immediately after the G53 repair deployment and before fresh
-- application verification.

DELETE FROM serialized_dcb_allocator_bindings
WHERE service_id = 'sekiban-dcb-meeting-room-cloudflare-only';

DELETE FROM serialized_dcb_source_partitions
WHERE service_id = 'sekiban-dcb-meeting-room-cloudflare-only';

DELETE FROM serialized_dcb_completeness_scanner_health
WHERE service_id = 'sekiban-dcb-meeting-room-cloudflare-only';

DELETE FROM serialized_dcb_completeness_findings
WHERE service_id = 'sekiban-dcb-meeting-room-cloudflare-only';

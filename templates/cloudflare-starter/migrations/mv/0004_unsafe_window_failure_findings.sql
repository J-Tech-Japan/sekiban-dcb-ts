-- SDT-G25: an unsafe apply failure is an idempotent operational finding.
-- The source event is already durable; this records that the exceptional
-- immediate projection write requires Queue retry or DLQ attention.
CREATE TABLE mv_unsafe_failure_findings (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL CHECK (classification IN ('UNSAFE_APPLY_RETRY')),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, view_id, event_id, suid, classification)
);

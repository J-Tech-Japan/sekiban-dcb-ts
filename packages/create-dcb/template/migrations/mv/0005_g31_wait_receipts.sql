-- SDT-G31: a wait receipt is an active-generation/definition observation.
-- It is intentionally separate from mv_unsafe_receipts, whose historical
-- identity is cross-generation and remains the G23/G26 delivery oracle.
CREATE TABLE mv_wait_receipts (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  definition_version INTEGER NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, view_id, generation, event_id, suid),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
    ON DELETE CASCADE
);
CREATE INDEX mv_wait_receipts_active_target_idx
  ON mv_wait_receipts (
    service_id,
    view_id,
    generation,
    definition_version,
    event_id COLLATE BINARY,
    suid COLLATE BINARY
  );

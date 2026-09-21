-- SDT-G65 AC0 receiver ring/apply ledger.
--
-- The ring is the only receiver work awaited by the Tag Durable Object.  The
-- message bytes are retained before the RPC returns; the receiver then reads
-- this durable row from its own execution context and performs the existing
-- idempotent D1 delivery/apply.  This table is diagnostic/transport state, not
-- an event or admission authority.
CREATE TABLE serialized_dcb_g65_direct_rings (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  attempt_id TEXT NOT NULL COLLATE BINARY,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  message_json TEXT NOT NULL,
  ring_started_at INTEGER NOT NULL CHECK (ring_started_at >= 0),
  ring_finished_at INTEGER NOT NULL CHECK (ring_finished_at >= ring_started_at),
  ring_outcome TEXT NOT NULL CHECK (ring_outcome IN ('rung', 'duplicate')),
  apply_started_at INTEGER,
  apply_finished_at INTEGER,
  apply_outcome TEXT,
  apply_error TEXT,
  PRIMARY KEY (service_id, event_id, attempt_id)
);

CREATE INDEX serialized_dcb_g65_direct_rings_service_time_idx
  ON serialized_dcb_g65_direct_rings (service_id, ring_finished_at ASC, event_id COLLATE BINARY);

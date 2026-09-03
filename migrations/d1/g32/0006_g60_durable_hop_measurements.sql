-- SDT-G60 AC1 operational hop ledger.
--
-- This table is intentionally outside the logical event record and has no
-- foreign key to dcb_events: command receipt is captured before downstream
-- delivery creates the global event row. Stable EventId/SUID/attempt identity
-- is retained in every stage row; no protocol or public response reads it.
CREATE TABLE serialized_dcb_hop_measurements (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  attempt_id TEXT NOT NULL COLLATE BINARY,
  stage TEXT NOT NULL CHECK (stage IN (
    'command-receipt',
    'tag-append-committed',
    'outbox-obligation-written',
    'queue-send-returned',
    'consumer-invocation-started',
    'record-delivery-batch-committed',
    'first-unsafe-visible-read'
  )),
  partition_tag TEXT NOT NULL COLLATE BINARY DEFAULT '',
  view_id TEXT NOT NULL COLLATE BINARY DEFAULT '',
  transport TEXT NOT NULL CHECK (transport IN ('', 'queue', 'fast', 'import', 'public-read')),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (service_id, event_id, stage, partition_tag, view_id, transport)
);

CREATE INDEX serialized_dcb_hop_measurements_service_event_idx
  ON serialized_dcb_hop_measurements (service_id, event_id COLLATE BINARY, observed_at ASC);
CREATE INDEX serialized_dcb_hop_measurements_service_time_idx
  ON serialized_dcb_hop_measurements (service_id, observed_at ASC, stage COLLATE BINARY);

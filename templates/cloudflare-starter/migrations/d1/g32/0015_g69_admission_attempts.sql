-- SDT-G69 AC3 append-only per-recordDelivery admission-attempt evidence.
-- This table is diagnostic only. No Queue, retry, G44, MV, or public-read
-- path may use it as an authority.
CREATE TABLE serialized_dcb_g69_admission_attempts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  delivery_source TEXT NOT NULL CHECK (delivery_source IN ('queue', 'fast', 'import')),
  queue_message_id TEXT NOT NULL COLLATE BINARY,
  attempt_id TEXT NOT NULL COLLATE BINARY,
  allocator_lineage_id TEXT NOT NULL COLLATE BINARY,
  obligation_sequence INTEGER NOT NULL CHECK (obligation_sequence >= 1),
  enqueued_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  arrived_at INTEGER NOT NULL,
  first_arrived_at_before INTEGER,
  last_arrived_at_before INTEGER,
  first_arrived_at_after INTEGER,
  last_arrived_at_after INTEGER,
  receipt_status TEXT NOT NULL CHECK (receipt_status IN ('stored', 'duplicate', 'suid-collision', 'lineage-mismatch', 'failed')),
  retry_reason TEXT,
  clock_origin TEXT NOT NULL CHECK (clock_origin = 'Date.now epoch ms')
);

CREATE INDEX serialized_dcb_g69_admission_attempts_identity_idx
  ON serialized_dcb_g69_admission_attempts
     (service_id, event_id COLLATE BINARY, sequence ASC);

CREATE INDEX serialized_dcb_g69_admission_attempts_arrival_idx
  ON serialized_dcb_g69_admission_attempts
     (service_id, partition_tag COLLATE BINARY, observed_at ASC);

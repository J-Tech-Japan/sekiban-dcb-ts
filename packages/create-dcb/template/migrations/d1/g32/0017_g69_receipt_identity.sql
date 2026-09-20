-- SDT-G69 F5: keep the diagnostic Queue wrapper identity distinct from the
-- envelope attempt identity. Direct delivery has no Queue wrapper, so its
-- queue_message_id is intentionally nullable. This table remains diagnostic;
-- no admission, retry, G44 or safe-lane path reads it.
DROP INDEX IF EXISTS serialized_dcb_g69_admission_attempts_identity_idx;
DROP INDEX IF EXISTS serialized_dcb_g69_admission_attempts_arrival_idx;
DROP INDEX IF EXISTS serialized_dcb_g69_admission_attempts_retention_idx;
ALTER TABLE serialized_dcb_g69_admission_attempts RENAME TO serialized_dcb_g69_admission_attempts_legacy;

CREATE TABLE serialized_dcb_g69_admission_attempts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  delivery_source TEXT NOT NULL CHECK (delivery_source IN ('queue', 'fast', 'import')),
  queue_message_id TEXT COLLATE BINARY,
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
  before_observed_at INTEGER,
  after_observed_at INTEGER,
  observation_consistency TEXT NOT NULL DEFAULT 'unverified',
  receipt_status TEXT NOT NULL CHECK (receipt_status IN ('stored', 'duplicate', 'suid-collision', 'lineage-mismatch', 'failed')),
  retry_reason TEXT,
  clock_origin TEXT NOT NULL CHECK (clock_origin = 'Date.now epoch ms')
);

INSERT INTO serialized_dcb_g69_admission_attempts (
  sequence, service_id, event_id, suid, partition_tag, delivery_source,
  queue_message_id, attempt_id, allocator_lineage_id, obligation_sequence,
  enqueued_at, observed_at, arrived_at, first_arrived_at_before,
  last_arrived_at_before, first_arrived_at_after, last_arrived_at_after,
  before_observed_at, after_observed_at, observation_consistency,
  receipt_status, retry_reason, clock_origin
)
SELECT sequence, service_id, event_id, suid, partition_tag, delivery_source,
       queue_message_id, attempt_id, allocator_lineage_id, obligation_sequence,
       enqueued_at, observed_at, arrived_at, first_arrived_at_before,
       last_arrived_at_before, first_arrived_at_after, last_arrived_at_after,
       before_observed_at, after_observed_at, observation_consistency,
       receipt_status, retry_reason, clock_origin
  FROM serialized_dcb_g69_admission_attempts_legacy;

DROP TABLE serialized_dcb_g69_admission_attempts_legacy;

CREATE INDEX serialized_dcb_g69_admission_attempts_identity_idx
  ON serialized_dcb_g69_admission_attempts
     (service_id, event_id COLLATE BINARY, sequence ASC);
CREATE INDEX serialized_dcb_g69_admission_attempts_arrival_idx
  ON serialized_dcb_g69_admission_attempts
     (service_id, partition_tag COLLATE BINARY, observed_at ASC);
CREATE INDEX serialized_dcb_g69_admission_attempts_retention_idx
  ON serialized_dcb_g69_admission_attempts (service_id, sequence DESC);

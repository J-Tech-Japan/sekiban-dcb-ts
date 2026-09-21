-- SDT-G44 global-array completeness authority.
--
-- This is deliberately an ordinary in-place development migration.  The
-- repository has no production data to preserve: incompatible test data is
-- reset rather than bridged through a mixed-version protocol.

ALTER TABLE dcb_events ADD COLUMN "EventDigest" TEXT;

-- A source partition is a Tag Durable Object identity.  Its local
-- obligation_sequence has no global meaning, so the scanner snapshots this
-- set together with each partition's own high-water sequence.
CREATE TABLE serialized_dcb_source_partitions (
  service_id TEXT NOT NULL,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  last_obligation_sequence INTEGER NOT NULL,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, partition_tag)
);
CREATE INDEX serialized_dcb_source_partitions_service_idx
  ON serialized_dcb_source_partitions (service_id, partition_tag COLLATE BINARY);

-- A tag-side committed membership is distinct from dcb_events.Tags, which is
-- only the declared tag set.  It is written by the global array receiver in
-- the same D1 batch as the event and receipt.
CREATE TABLE serialized_dcb_global_memberships (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  event_digest TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, event_id, partition_tag),
  FOREIGN KEY (service_id, event_id) REFERENCES dcb_events ("ServiceId", "Id") ON DELETE RESTRICT
);
CREATE INDEX serialized_dcb_global_memberships_lookup_idx
  ON serialized_dcb_global_memberships (service_id, partition_tag COLLATE BINARY, event_id);

-- This receipt is the sink fact that a source obligation may read back.  It
-- is intentionally not a Queue acknowledgement and is never inferred from a
-- projection or delivery runner.  Its semantic identity is
-- (service_id, event_id, event_digest, membership_tag); the separate unique
-- source key maps that receipt back to the DO-local obligation sequence.
CREATE TABLE serialized_dcb_global_receipts (
  service_id TEXT NOT NULL,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  obligation_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  membership_tag TEXT NOT NULL COLLATE BINARY,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, partition_tag, obligation_sequence),
  UNIQUE (service_id, event_id, event_digest, membership_tag),
  FOREIGN KEY (service_id, event_id, membership_tag)
    REFERENCES serialized_dcb_global_memberships (service_id, event_id, partition_tag)
    ON DELETE RESTRICT
);
CREATE INDEX serialized_dcb_global_receipts_event_idx
  ON serialized_dcb_global_receipts (service_id, event_id, membership_tag COLLATE BINARY);

-- Independent scanner progress is explicit.  Its only interim operational
-- state is BLOCK/UNSETTLED; it deliberately has no owner/ack/closure fields.
CREATE TABLE serialized_dcb_completeness_scanner_health (
  service_id TEXT PRIMARY KEY,
  scanner_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('HEALTHY', 'UNKNOWN', 'FAILED', 'STALE', 'BLOCK', 'UNSETTLED')),
  cursor_json TEXT,
  last_full_scan_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE serialized_dcb_completeness_findings (
  service_id TEXT NOT NULL,
  incident_identity TEXT NOT NULL COLLATE BINARY,
  incident_type TEXT NOT NULL,
  -- Event fields are NULL only for a source-partition or scanner failure
  -- discovered before a specific obligation can be read. The same findings
  -- table remains the sole unresolved-state authority.
  partition_tag TEXT COLLATE BINARY,
  obligation_sequence INTEGER,
  event_id TEXT,
  event_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'UNRESOLVED')),
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, incident_identity)
);
CREATE INDEX serialized_dcb_completeness_findings_open_idx
  ON serialized_dcb_completeness_findings (service_id, state, partition_tag COLLATE BINARY, obligation_sequence);

-- SDT-G18 versioned D1 schema. Runtime code never executes DDL.
-- SUID values are opaque bytewise ordinals; every persisted SUID column and
-- index therefore declares COLLATE BINARY explicitly.
CREATE TABLE serialized_dcb_events (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  suid TEXT NOT NULL COLLATE BINARY,
  payload TEXT NOT NULL,
  allocator_lineage_id TEXT NOT NULL,
  event_tags TEXT NOT NULL,
  first_arrived_at INTEGER NOT NULL,
  last_arrived_at INTEGER NOT NULL,
  max_delivery_lag_ms INTEGER NOT NULL,
  PRIMARY KEY (service_id, event_id),
  UNIQUE (service_id, suid COLLATE BINARY)
);
CREATE INDEX serialized_dcb_events_service_suid_idx
  ON serialized_dcb_events (service_id, suid COLLATE BINARY, event_id COLLATE BINARY);

CREATE TABLE serialized_dcb_allocator_bindings (
  service_id TEXT PRIMARY KEY,
  allocator_lineage_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);

CREATE TABLE serialized_dcb_event_arrivals (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tag TEXT NOT NULL COLLATE BINARY,
  enqueued_at INTEGER NOT NULL,
  arrived_at INTEGER NOT NULL,
  lag_ms INTEGER NOT NULL,
  PRIMARY KEY (service_id, event_id, tag),
  FOREIGN KEY (service_id, event_id)
    REFERENCES serialized_dcb_events (service_id, event_id)
    ON DELETE CASCADE
);
CREATE INDEX serialized_dcb_event_arrivals_service_idx
  ON serialized_dcb_event_arrivals (service_id, event_id, tag COLLATE BINARY);

CREATE TABLE serialized_dcb_lag_estimates (
  service_id TEXT PRIMARY KEY,
  estimate_ms INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE serialized_dcb_pending_arrivals (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  suid TEXT NOT NULL COLLATE BINARY,
  expected_paths TEXT NOT NULL,
  observed_paths TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  lag_bound_ms INTEGER NOT NULL,
  PRIMARY KEY (service_id, event_id)
);
CREATE INDEX serialized_dcb_pending_service_idx
  ON serialized_dcb_pending_arrivals (service_id, event_id COLLATE BINARY);

CREATE TABLE serialized_dcb_inconsistency_findings (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  path TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  lag_bound_ms INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (service_id, event_id, path, classification)
);

CREATE TABLE serialized_dcb_delivery_incidents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  identity_key TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL,
  suid TEXT COLLATE BINARY,
  existing_event_id TEXT,
  incoming_event_id TEXT,
  event_id TEXT,
  bound_lineage_id TEXT,
  incoming_lineage_id TEXT,
  observed_at INTEGER NOT NULL,
  UNIQUE (service_id, identity_key)
);

CREATE TABLE serialized_dcb_projection_checkpoints (
  service_id TEXT NOT NULL,
  projection_id TEXT NOT NULL COLLATE BINARY,
  last_suid TEXT NOT NULL COLLATE BINARY,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, projection_id)
);

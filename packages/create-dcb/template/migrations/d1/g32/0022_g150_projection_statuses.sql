-- Passive projection-status heartbeats live in the event-source database.
-- Apply this migration before serving the status route. Runtime code does not create the table.
CREATE TABLE dcb_projection_statuses (
  service_id TEXT NOT NULL,
  projector_name TEXT NOT NULL COLLATE BINARY,
  projector_version TEXT NOT NULL COLLATE BINARY,
  cluster_id TEXT NOT NULL COLLATE BINARY,
  activation_id TEXT NOT NULL COLLATE BINARY,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  applied_event_count INTEGER NOT NULL CHECK (applied_event_count >= 0),
  last_applied_sortable_unique_id TEXT COLLATE BINARY,
  last_traversed_sortable_unique_id TEXT COLLATE BINARY,
  recorded_at_utc INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'unknown', 'starting', 'catchingUp', 'active', 'caughtUp', 'faulted', 'stopped'
  )),
  lease_expires_at_utc INTEGER,
  is_faulted INTEGER NOT NULL CHECK (is_faulted IN (0, 1)),
  fault_message TEXT,
  switch_kind TEXT,
  switch_reason TEXT,
  switched_at_utc INTEGER,
  PRIMARY KEY (service_id, projector_name, projector_version, cluster_id),
  CHECK (fault_message IS NULL OR length(fault_message) <= 2048),
  CHECK (switch_kind IS NULL OR length(switch_kind) <= 32),
  CHECK (switch_reason IS NULL OR length(switch_reason) <= 1024),
  CHECK (length(service_id) BETWEEN 1 AND 64),
  CHECK (length(projector_name) BETWEEN 1 AND 256),
  CHECK (length(projector_version) BETWEEN 1 AND 128),
  CHECK (length(cluster_id) BETWEEN 1 AND 256),
  CHECK (length(activation_id) BETWEEN 1 AND 128)
);
CREATE INDEX ix_dcb_projection_statuses_projector
  ON dcb_projection_statuses (
    service_id,
    projector_name COLLATE BINARY,
    projector_version COLLATE BINARY,
    cluster_id COLLATE BINARY
  );

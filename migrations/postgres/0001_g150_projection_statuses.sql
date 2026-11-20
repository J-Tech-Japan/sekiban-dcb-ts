-- Passive projection-status heartbeats. Provision this table before runtime use.
-- The event-store connection executes DML only and does not create this table.
CREATE TABLE IF NOT EXISTS dcb_projection_statuses (
  service_id varchar(64) NOT NULL,
  projector_name varchar(256) NOT NULL,
  projector_version varchar(128) NOT NULL,
  cluster_id varchar(256) NOT NULL,
  activation_id varchar(128) NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  applied_event_count bigint NOT NULL CHECK (applied_event_count >= 0),
  last_applied_sortable_unique_id varchar(100) NULL,
  last_traversed_sortable_unique_id varchar(100) NULL,
  recorded_at_utc timestamp with time zone NOT NULL,
  phase varchar(64) NOT NULL CHECK (phase IN (
    'unknown', 'starting', 'catchingUp', 'active', 'caughtUp', 'faulted', 'stopped'
  )),
  lease_expires_at_utc timestamp with time zone NULL,
  is_faulted boolean NOT NULL DEFAULT FALSE,
  fault_message varchar(2048) NULL,
  switch_kind varchar(32) NULL,
  switch_reason varchar(1024) NULL,
  switched_at_utc timestamp with time zone NULL,
  CONSTRAINT pk_dcb_projection_statuses PRIMARY KEY
    (service_id, projector_name, projector_version, cluster_id)
);
CREATE INDEX IF NOT EXISTS ix_dcb_projection_statuses_projector
  ON dcb_projection_statuses (service_id, projector_name, projector_version, cluster_id);

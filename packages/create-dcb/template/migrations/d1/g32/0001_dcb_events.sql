-- SDT-G32 new-database baseline. This directory is selected only by the
-- wipe/cutover worker configuration; it deliberately does not migrate or read
-- serialized_dcb_events from the pre-G32 service.

CREATE TABLE dcb_events (
  "ServiceId" TEXT NOT NULL,
  "Id" TEXT NOT NULL,
  "SortableUniqueId" TEXT NOT NULL COLLATE BINARY,
  "EventType" TEXT NOT NULL,
  "Payload" TEXT NOT NULL,
  "Tags" TEXT NOT NULL,
  "Timestamp" TEXT NOT NULL,
  "CausationId" TEXT,
  "CorrelationId" TEXT,
  "ExecutedUser" TEXT,
  CONSTRAINT "PK_dcb_events" PRIMARY KEY ("ServiceId", "Id")
);
CREATE INDEX "IX_Events_ServiceId" ON dcb_events ("ServiceId");
CREATE INDEX "IX_Events_Service_SortableUniqueId" ON dcb_events ("ServiceId", "SortableUniqueId" COLLATE BINARY);
CREATE INDEX "IX_dcb_events_EventType" ON dcb_events ("EventType");
CREATE INDEX "IX_dcb_events_Timestamp" ON dcb_events ("Timestamp");

-- Operational facts are intentionally outside the C# logical event record.
CREATE TABLE dcb_event_ops (
  "ServiceId" TEXT NOT NULL,
  "Id" TEXT NOT NULL,
  "AttemptId" TEXT,
  "AllocatorLineageId" TEXT,
  "FirstArrivedAt" INTEGER NOT NULL,
  "LastArrivedAt" INTEGER NOT NULL,
  "MaxDeliveryLagMs" INTEGER NOT NULL,
  PRIMARY KEY ("ServiceId", "Id"),
  FOREIGN KEY ("ServiceId", "Id") REFERENCES dcb_events ("ServiceId", "Id") ON DELETE CASCADE
);

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
  FOREIGN KEY (service_id, event_id) REFERENCES dcb_events ("ServiceId", "Id") ON DELETE CASCADE
);
CREATE INDEX serialized_dcb_event_arrivals_service_idx ON serialized_dcb_event_arrivals (service_id, event_id, tag COLLATE BINARY);

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
CREATE INDEX serialized_dcb_pending_service_idx ON serialized_dcb_pending_arrivals (service_id, event_id COLLATE BINARY);

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

CREATE TABLE serialized_dcb_wait_target_incidents (
  service_id TEXT NOT NULL,
  suid TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL,
  event_id TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, suid, classification)
);
CREATE INDEX serialized_dcb_wait_target_incidents_lookup_idx
  ON serialized_dcb_wait_target_incidents (service_id, suid COLLATE BINARY, classification);

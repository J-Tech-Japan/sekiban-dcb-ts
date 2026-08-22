-- SDT-G31 waitFor target incident aliases. Delivery incidents remain their
-- historical/operator identity; this compact table makes a target-SUID gate
-- an indexed point read even when the rejected message never became a row.
CREATE TABLE serialized_dcb_wait_target_incidents (
  service_id TEXT NOT NULL,
  suid TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL CHECK (classification IN ('SUID_COLLISION', 'LINEAGE_MISMATCH')),
  event_id TEXT NOT NULL COLLATE BINARY,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, suid, classification)
);
CREATE INDEX serialized_dcb_wait_target_incidents_lookup_idx
  ON serialized_dcb_wait_target_incidents (
    service_id,
    suid COLLATE BINARY,
    classification
  );

-- Compatibility point lookup for a pre-G31 collision incident that was
-- already durable before the alias table existed.
CREATE INDEX serialized_dcb_delivery_incidents_wait_target_idx
  ON serialized_dcb_delivery_incidents (
    service_id,
    classification,
    suid COLLATE BINARY
  );

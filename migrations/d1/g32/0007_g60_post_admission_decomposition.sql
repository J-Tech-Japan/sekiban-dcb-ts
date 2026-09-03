-- SDT-G60 post-admission decomposition observations.
--
-- This is a separate append-only operational ledger so the original seven-hop
-- table and its deployed schema remain unchanged. Every row retains the exact
-- event/SUID/attempt identity; no protocol path reads this table.
CREATE TABLE serialized_dcb_hop_submeasurements (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  attempt_id TEXT NOT NULL COLLATE BINARY,
  stage TEXT NOT NULL CHECK (stage IN (
    'post-record-delivery-global-receipt-readback',
    'source-tag-acknowledgement',
    'completeness-coverage',
    'detector',
    'unsafe-view-apply'
  )),
  boundary TEXT NOT NULL CHECK (boundary IN ('start', 'end')),
  outcome TEXT NOT NULL CHECK (length(outcome) > 0),
  partition_tag TEXT NOT NULL COLLATE BINARY DEFAULT '',
  view_id TEXT NOT NULL COLLATE BINARY DEFAULT '',
  transport TEXT NOT NULL CHECK (transport IN ('', 'queue', 'fast', 'import', 'public-read')),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (service_id, event_id, stage, boundary, partition_tag, view_id, transport)
);

CREATE INDEX serialized_dcb_hop_submeasurements_service_event_idx
  ON serialized_dcb_hop_submeasurements (service_id, event_id COLLATE BINARY, observed_at ASC);
CREATE INDEX serialized_dcb_hop_submeasurements_service_time_idx
  ON serialized_dcb_hop_submeasurements (service_id, observed_at ASC, stage COLLATE BINARY, boundary COLLATE BINARY);

-- SDT-G60 concrete unsafe-row writer boundaries.
--
-- This is observation-only. It has no foreign keys and is never read by
-- admission, Queue acknowledgement, projection fencing, or public reads.
-- Each row retains the exact event/SUID/attempt/view identity and names the
-- concrete path at the unsafe apply boundary.
CREATE TABLE serialized_dcb_unsafe_writer_boundaries (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  attempt_id TEXT NOT NULL COLLATE BINARY,
  writer_path TEXT NOT NULL CHECK (writer_path IN ('inline-delivery', 'scheduled-drain')),
  boundary TEXT NOT NULL CHECK (boundary IN ('start', 'end')),
  outcome TEXT NOT NULL CHECK (length(outcome) > 0),
  view_id TEXT NOT NULL COLLATE BINARY,
  transport TEXT NOT NULL CHECK (transport IN ('', 'queue', 'fast', 'import', 'scheduled')),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (service_id, event_id, writer_path, view_id, boundary, transport)
);

CREATE INDEX serialized_dcb_unsafe_writer_boundaries_service_event_idx
  ON serialized_dcb_unsafe_writer_boundaries (service_id, event_id COLLATE BINARY, observed_at ASC);
CREATE INDEX serialized_dcb_unsafe_writer_boundaries_service_time_idx
  ON serialized_dcb_unsafe_writer_boundaries (service_id, observed_at ASC, writer_path COLLATE BINARY, view_id COLLATE BINARY);

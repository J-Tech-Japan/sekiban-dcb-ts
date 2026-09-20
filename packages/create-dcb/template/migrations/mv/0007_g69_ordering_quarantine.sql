-- SDT-G69 consultation-003: an ordering detector quarantines only the
-- affected active generation. A rebuild/promote moves the active pointer and
-- resolves the old generation's quarantine without weakening frontier rules.
CREATE TABLE mv_ordering_quarantines (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  checkpoint_suid TEXT NOT NULL COLLATE BINARY,
  late_suid TEXT NOT NULL COLLATE BINARY,
  event_id TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL CHECK (classification IN ('LATE_LOWER_SUID', 'ORDER_VIOLATION')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  observed_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (service_id, view_id, generation),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
    ON DELETE CASCADE
);
CREATE INDEX mv_ordering_quarantines_active_idx
  ON mv_ordering_quarantines (service_id, view_id, status, generation);

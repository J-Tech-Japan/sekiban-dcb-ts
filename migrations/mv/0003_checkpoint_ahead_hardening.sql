-- SDT-G24 checkpoint-ahead hardening. A finding is scoped to the affected
-- generation, so the only recovery path is the existing rebuild/promote flow.
CREATE TABLE mv_checkpoint_ahead_findings (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  checkpoint_suid TEXT NOT NULL COLLATE BINARY,
  store_max_suid TEXT NOT NULL COLLATE BINARY,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, view_id, generation),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
    ON DELETE CASCADE
);

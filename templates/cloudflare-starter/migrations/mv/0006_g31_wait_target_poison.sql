-- SDT-G31: poison is a target fact for one active generation/definition, not
-- a global view switch. This lets the wait loop use the same bounded active
-- generation point-read shape for receipt, checkpoint, rebuild, and poison.
CREATE TABLE mv_wait_target_poison (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  definition_version INTEGER NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  classification TEXT NOT NULL CHECK (classification IN ('UNSAFE_APPLY_RETRY')),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, view_id, generation, event_id, suid, classification),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
    ON DELETE CASCADE
);
CREATE INDEX mv_wait_target_poison_active_target_idx
  ON mv_wait_target_poison (
    service_id,
    view_id,
    generation,
    definition_version,
    event_id COLLATE BINARY,
    suid COLLATE BINARY
  );

-- Preserve historical pre-G31 poison as a finding on the generation that was
-- active while this migration ran. A later generation is deliberately free to
-- rebuild and prove its own state without inheriting an old receipt/failure.
INSERT OR IGNORE INTO mv_wait_target_poison
  (service_id, view_id, generation, definition_version, event_id, suid, classification, observed_at)
SELECT finding.service_id,
       finding.view_id,
       instance.generation,
       instance.definition_version,
       finding.event_id,
       finding.suid,
       finding.classification,
       finding.observed_at
  FROM mv_unsafe_failure_findings finding
  JOIN mv_active_generations active
    ON active.service_id = finding.service_id
   AND active.view_id = finding.view_id
  JOIN mv_instances instance
    ON instance.service_id = active.service_id
   AND instance.view_id = active.view_id
   AND instance.generation = active.generation;

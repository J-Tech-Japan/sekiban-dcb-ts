-- SDT-G69 F3: a rebuild proof is durable, generation-bound, and tied to the
-- open ordering incident it repairs. The fields are populated only by the
-- real MaterializedViewCatchUpRuntime rebuild path.
ALTER TABLE mv_instances ADD COLUMN rebuild_recovery_id TEXT;
ALTER TABLE mv_instances ADD COLUMN rebuild_incident_identity TEXT;
ALTER TABLE mv_instances ADD COLUMN rebuild_incident_generation INTEGER;
ALTER TABLE mv_instances ADD COLUMN rebuild_source_event_count INTEGER;
ALTER TABLE mv_instances ADD COLUMN rebuild_source_max_suid TEXT;
ALTER TABLE mv_instances ADD COLUMN rebuild_source_history_digest TEXT;

ALTER TABLE mv_ordering_quarantines ADD COLUMN incident_identity TEXT;

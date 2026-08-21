-- SDT-G27 additive identity migration.  0001 remains the pre-G27 schema so
-- existing databases can apply this migration exactly once; fresh installs
-- apply 0001 followed by this file through Wrangler's versioned migration
-- workflow.
ALTER TABLE serialized_dcb_events ADD COLUMN event_type TEXT;
ALTER TABLE serialized_dcb_events ADD COLUMN event_provenance TEXT NOT NULL DEFAULT 'pre-g27';

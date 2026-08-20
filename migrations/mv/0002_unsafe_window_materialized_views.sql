-- SDT-G23 unsafe-window layer.  This is deliberately a new migration: 0001
-- is already applied to deployed G19/G20 MV databases and Wrangler keys its
-- migration ledger by filename.
CREATE TABLE mv_unsafe_rows (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  row_key TEXT NOT NULL COLLATE BINARY,
  value_json TEXT NOT NULL,
  row_version INTEGER NOT NULL,
  source_suid TEXT NOT NULL COLLATE BINARY,
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1)),
  PRIMARY KEY (service_id, view_id, generation, row_key),
  FOREIGN KEY (service_id, view_id, generation) REFERENCES mv_instances (service_id, view_id, generation) ON DELETE CASCADE
);
CREATE INDEX mv_unsafe_rows_generation_idx ON mv_unsafe_rows (service_id, view_id, generation, row_key COLLATE BINARY);

CREATE TABLE mv_unsafe_index_entries (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  index_id TEXT NOT NULL COLLATE BINARY,
  value_type TEXT NOT NULL CHECK (value_type IN ('text', 'integer', 'real')),
  text_value TEXT COLLATE BINARY,
  integer_value INTEGER,
  real_value REAL,
  row_key TEXT NOT NULL COLLATE BINARY,
  PRIMARY KEY (service_id, view_id, generation, index_id, value_type, text_value, integer_value, real_value, row_key),
  FOREIGN KEY (service_id, view_id, generation) REFERENCES mv_instances (service_id, view_id, generation) ON DELETE CASCADE,
  CHECK ((value_type = 'text' AND text_value IS NOT NULL AND integer_value IS NULL AND real_value IS NULL) OR (value_type = 'integer' AND text_value IS NULL AND integer_value IS NOT NULL AND real_value IS NULL) OR (value_type = 'real' AND text_value IS NULL AND integer_value IS NULL AND real_value IS NOT NULL))
);
CREATE INDEX mv_unsafe_index_entries_typed_idx ON mv_unsafe_index_entries (service_id, view_id, generation, index_id, value_type, text_value COLLATE BINARY, integer_value, real_value, row_key COLLATE BINARY);

CREATE TABLE mv_unsafe_receipts (
  service_id TEXT NOT NULL, view_id TEXT NOT NULL COLLATE BINARY,
  event_id TEXT NOT NULL COLLATE BINARY, suid TEXT NOT NULL COLLATE BINARY,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'older', 'patch-not-found', 'delete-without-row', 'no-change')),
  observed_at INTEGER NOT NULL, PRIMARY KEY (service_id, view_id, event_id, suid)
);
CREATE TABLE mv_unsafe_markers (
  service_id TEXT NOT NULL, view_id TEXT NOT NULL COLLATE BINARY, generation INTEGER NOT NULL,
  row_key TEXT NOT NULL COLLATE BINARY, event_id TEXT NOT NULL COLLATE BINARY, suid TEXT NOT NULL COLLATE BINARY,
  reason TEXT NOT NULL CHECK (reason IN ('patch-not-found', 'delete-without-row', 'no-change', 'older')),
  PRIMARY KEY (service_id, view_id, generation, row_key, event_id, suid, reason)
);
CREATE TABLE mv_unsafe_arrivals (
  service_id TEXT NOT NULL, view_id TEXT NOT NULL COLLATE BINARY, generation INTEGER NOT NULL,
  safe_head TEXT NOT NULL COLLATE BINARY DEFAULT '', arrival_watermark TEXT NOT NULL COLLATE BINARY DEFAULT '',
  behind_frontier_event_id TEXT COLLATE BINARY, behind_frontier_suid TEXT COLLATE BINARY,
  rebuild_required INTEGER NOT NULL DEFAULT 0 CHECK (rebuild_required IN (0, 1)),
  PRIMARY KEY (service_id, view_id, generation)
);
CREATE TABLE mv_unsafe_kicks (
  service_id TEXT NOT NULL, view_id TEXT NOT NULL COLLATE BINARY,
  target_suid TEXT NOT NULL COLLATE BINARY DEFAULT '', lease_owner TEXT COLLATE BINARY,
  lease_until INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  PRIMARY KEY (service_id, view_id)
);

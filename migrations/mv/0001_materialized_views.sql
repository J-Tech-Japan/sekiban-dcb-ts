-- SDT-G19 versioned MV schema. Runtime code never executes DDL.
-- Pipeline D1 and MV D1 are separate bindings; checkpoints live beside rows.
CREATE TABLE mv_instances (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'retired')),
  last_suid TEXT NOT NULL COLLATE BINARY,
  definition_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, view_id, generation)
);

CREATE UNIQUE INDEX mv_instances_active_idx
  ON mv_instances (service_id, view_id, status)
  WHERE status = 'active';

CREATE TABLE mv_active_generations (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, view_id),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
);

CREATE TABLE mv_rows (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  row_key TEXT NOT NULL COLLATE BINARY,
  value_json TEXT NOT NULL,
  row_version INTEGER NOT NULL,
  source_suid TEXT NOT NULL COLLATE BINARY,
  PRIMARY KEY (service_id, view_id, generation, row_key),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
    ON DELETE CASCADE
);
CREATE INDEX mv_rows_generation_idx
  ON mv_rows (service_id, view_id, generation, row_key COLLATE BINARY);

CREATE TABLE mv_index_entries (
  service_id TEXT NOT NULL,
  view_id TEXT NOT NULL COLLATE BINARY,
  generation INTEGER NOT NULL,
  index_id TEXT NOT NULL COLLATE BINARY,
  value_type TEXT NOT NULL CHECK (value_type IN ('text', 'integer', 'real')),
  text_value TEXT COLLATE BINARY,
  integer_value INTEGER,
  real_value REAL,
  row_key TEXT NOT NULL COLLATE BINARY,
  PRIMARY KEY (service_id, view_id, generation, index_id, value_type,
               text_value, integer_value, real_value, row_key),
  FOREIGN KEY (service_id, view_id, generation)
    REFERENCES mv_instances (service_id, view_id, generation)
    ON DELETE CASCADE,
  CHECK (
    (value_type = 'text' AND text_value IS NOT NULL AND integer_value IS NULL AND real_value IS NULL)
    OR (value_type = 'integer' AND text_value IS NULL AND integer_value IS NOT NULL AND real_value IS NULL)
    OR (value_type = 'real' AND text_value IS NULL AND integer_value IS NULL AND real_value IS NOT NULL)
  )
);

CREATE INDEX mv_index_entries_typed_idx
  ON mv_index_entries (
    service_id, view_id, generation, index_id, value_type,
    text_value COLLATE BINARY, integer_value, real_value, row_key COLLATE BINARY
  );

-- SQLite permits NULLs in an ordinary composite primary key. This expression
-- index makes the nullable typed columns behave as one typed value for
-- idempotent index insertion while retaining the public typed columns above.
CREATE UNIQUE INDEX mv_index_entries_unique_typed_idx
  ON mv_index_entries (
    service_id, view_id, generation, index_id, value_type,
    COALESCE(text_value, CAST(integer_value AS TEXT), CAST(real_value AS TEXT)),
    row_key COLLATE BINARY
  );

-- A NOT NULL guard row is inserted and deleted in each atomic batch.  A stale
-- CAS selects NULL, causing the batch to abort before any mutation executes.
CREATE TABLE mv_atomic_guards (
  operation_id TEXT PRIMARY KEY COLLATE BINARY,
  checkpoint_match INTEGER NOT NULL CHECK (checkpoint_match = 1)
);

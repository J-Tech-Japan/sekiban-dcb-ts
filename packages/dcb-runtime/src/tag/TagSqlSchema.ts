/**
 * SDT-G43's tag-local authority is intentionally a normal SQLite schema, not
 * a serialized application record hidden behind a KV key.  These statements
 * are kept literal so schema review and `sqlite_master` introspection see the
 * exact primary keys, uniqueness constraints, foreign keys, and indexes.
 *
 * Existing TAG_KEY records are deliberately not migrated.  This repository is
 * still in development and the operator ruling for G43 is to reset those test
 * records rather than introduce a mixed-format or rollback protocol.
 */
export const TAG_SQL_SCHEMA_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tag_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tag TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tag_control (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 3),
    head_suid TEXT NOT NULL,
    clock_offset_ms INTEGER NOT NULL,
    clock_now_ms INTEGER,
    version INTEGER NOT NULL,
    repair_owner TEXT,
    repair_lease_until INTEGER,
    highest_repair_epoch INTEGER NOT NULL,
    repair_scope_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (singleton) REFERENCES tag_identity(singleton) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS tag_reservation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    attempt_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    reservation_token TEXT NOT NULL UNIQUE,
    expected_head TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    alarm_due_at INTEGER NOT NULL,
    FOREIGN KEY (singleton) REFERENCES tag_identity(singleton) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS tag_reservation_due_idx ON tag_reservation(alarm_due_at);

  CREATE TABLE IF NOT EXISTS tag_epoch (
    attempt_id TEXT PRIMARY KEY,
    highest_epoch INTEGER NOT NULL,
    sealed_epoch INTEGER,
    confirmation_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS tag_tombstone (
    attempt_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tag_event (
    service_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    suid TEXT NOT NULL,
    payload TEXT NOT NULL,
    event_tags_json TEXT NOT NULL,
    allocator_lineage_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance = 'g32'),
    timestamp TEXT NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (service_id, event_id),
    UNIQUE (suid)
  );
  CREATE INDEX IF NOT EXISTS tag_event_suid_idx ON tag_event(suid);
  CREATE INDEX IF NOT EXISTS tag_event_attempt_idx ON tag_event(attempt_id, event_id);

  CREATE TABLE IF NOT EXISTS tag_head (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    service_id TEXT NOT NULL,
    head_suid TEXT NOT NULL,
    FOREIGN KEY (singleton) REFERENCES tag_identity(singleton) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS tag_committed_membership (
    service_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY (service_id, event_id, tag),
    FOREIGN KEY (service_id, event_id)
      REFERENCES tag_event(service_id, event_id) ON DELETE RESTRICT,
    FOREIGN KEY (tag) REFERENCES tag_identity(tag) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS tag_committed_membership_tag_idx
    ON tag_committed_membership(tag, service_id, event_id);

  CREATE TABLE IF NOT EXISTS tag_outbox_obligation (
    obligation_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    suid TEXT NOT NULL,
    payload TEXT NOT NULL,
    allocator_lineage_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance = 'g32'),
    timestamp TEXT NOT NULL,
    canonical_bytes BLOB NOT NULL,
    event_digest TEXT NOT NULL,
    declared_tag_set_json TEXT NOT NULL,
    local_committed_membership_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'poison')),
    next_attempt_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    enqueued_at INTEGER,
    acknowledged_at INTEGER,
    last_error TEXT,
    UNIQUE (service_id, event_id, attempt_id),
    FOREIGN KEY (service_id, event_id)
      REFERENCES tag_event(service_id, event_id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS tag_outbox_obligation_due_idx
    ON tag_outbox_obligation(status, next_attempt_at, obligation_sequence);

  CREATE TABLE IF NOT EXISTS tag_commit_receipt (
    attempt_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    committed_at TEXT NOT NULL,
    committed_event_count INTEGER NOT NULL,
    head_suid TEXT NOT NULL,
    reservation_confirmed INTEGER NOT NULL CHECK (reservation_confirmed IN (0, 1)),
    PRIMARY KEY (attempt_id, epoch)
  );

  CREATE TABLE IF NOT EXISTS tag_fence (
    reason TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    PRIMARY KEY (reason, attempt_id)
  );

  CREATE TABLE IF NOT EXISTS tag_cleared_fence (
    reason TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    PRIMARY KEY (reason, attempt_id)
  );

  CREATE TABLE IF NOT EXISTS tag_bootstrap_admission (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    import_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL,
    manifest_digest TEXT NOT NULL,
    target_service_id TEXT NOT NULL,
    closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
    FOREIGN KEY (singleton) REFERENCES tag_identity(singleton) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS tag_repair_scope (
    attempt_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    PRIMARY KEY (attempt_id, event_id)
  );
`;

/**
 * Packet-owned AC8 range seam. The query text and index identity are exported
 * so the measurement checker can prove exactly what was explained and what
 * returned rows were compared against; no "equivalent" plan is accepted.
 */
export const TAG_READ_AFTER_INDEX = "tag_event_suid_idx";
export const TAG_READ_AFTER_SQL = `
  SELECT event_json
  FROM tag_event INDEXED BY tag_event_suid_idx
  WHERE suid > ?
  ORDER BY suid ASC
  LIMIT ?
`;

/**
 * SDT-G46's frozen-frontier form of the same G43 range index seam.  It is not
 * a second source path: a caller supplies the immutable `through` that the
 * first `g43TagStateIncrementalCatchUp` page obtained from `readHeadFacts`.
 */
export const TAG_READ_AFTER_THROUGH_SQL = `
  SELECT event_json
  FROM tag_event INDEXED BY tag_event_suid_idx
  WHERE suid > ? AND suid <= ?
  ORDER BY suid ASC
  LIMIT ?
`;

export function initializeTagSqlSchema(sql: SqlStorage): void {
  sql.exec(TAG_SQL_SCHEMA_DDL);
}

/** A SQL-backed tag object always exposes this capability at runtime. */
export function hasTagSqlStorage(storage: DurableObjectStorage): storage is DurableObjectStorage & { sql: SqlStorage } {
  return typeof storage.sql?.exec === "function";
}

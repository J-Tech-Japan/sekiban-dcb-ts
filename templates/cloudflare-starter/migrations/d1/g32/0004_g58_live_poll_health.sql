-- SDT-G58 AC5 live-poll lifecycle diagnostics.  This is additive and
-- observation-only: projection checkpoints and all SafeWindow/fence decisions
-- remain in their existing tables and transactions.
CREATE TABLE serialized_dcb_live_poll_health (
  service_id TEXT NOT NULL,
  projector_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'never-invoked',
    'invoked-and-threw',
    'invoked-but-no-work',
    'explicitly-gated',
    'advanced'
  )),
  reason TEXT,
  advanced_source_events INTEGER NOT NULL DEFAULT 0 CHECK (advanced_source_events >= 0),
  PRIMARY KEY (service_id, projector_id)
);

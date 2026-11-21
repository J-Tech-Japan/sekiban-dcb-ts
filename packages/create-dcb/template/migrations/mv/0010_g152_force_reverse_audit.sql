-- SDT-G152 force-reverse audit on the active pointer. Required for every D1 MV
-- deployment; runtime code never executes DDL.
ALTER TABLE mv_active_generations ADD COLUMN switch_kind TEXT
  NOT NULL DEFAULT 'legacy'
  CHECK (switch_kind IN ('ordinary', 'forced', 'legacy'));
ALTER TABLE mv_active_generations ADD COLUMN switch_reason TEXT NULL;
ALTER TABLE mv_active_generations ADD COLUMN switched_at INTEGER NULL;

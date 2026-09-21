-- SDT-G69 consultation-003: diagnostic observation is non-blocking and
-- ordering detection trusts only normal delivery timestamps.
-- Existing rows are deliberately marked unknown: imported/repaired history
-- cannot be promoted to a safety witness after the fact.
ALTER TABLE serialized_dcb_g69_admission_attempts ADD COLUMN before_observed_at INTEGER;
ALTER TABLE serialized_dcb_g69_admission_attempts ADD COLUMN after_observed_at INTEGER;
ALTER TABLE serialized_dcb_g69_admission_attempts ADD COLUMN observation_consistency TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE dcb_event_ops ADD COLUMN FirstArrivedSource TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE dcb_event_ops ADD COLUMN LastArrivedSource TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX serialized_dcb_g69_admission_attempts_retention_idx
  ON serialized_dcb_g69_admission_attempts (service_id, sequence DESC);

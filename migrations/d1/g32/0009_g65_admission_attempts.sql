-- SDT-G65 admission timing and outcome observations.
--
-- This is an operational ledger only.  No admission, Queue, projection, or
-- public response path reads it.  The clock is the Worker wall clock captured
-- at the boundary (`Date.now()`, epoch milliseconds); it is intentionally not
-- confused with an authored event timestamp or D1's received_at value.
CREATE TABLE serialized_dcb_g65_admission_attempts (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE BINARY,
  suid TEXT NOT NULL COLLATE BINARY,
  attempt_id TEXT NOT NULL COLLATE BINARY,
  partition_tag TEXT NOT NULL COLLATE BINARY,
  delivery_source TEXT NOT NULL CHECK (delivery_source IN ('fast')),
  admission_started_at INTEGER NOT NULL CHECK (admission_started_at >= 0),
  admission_finished_at INTEGER NOT NULL CHECK (admission_finished_at >= admission_started_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('admitted', 'not-admitted', 'unknown')),
  global_completion_observed_at INTEGER,
  clock_origin TEXT NOT NULL CHECK (clock_origin = 'Date.now epoch ms'),
  PRIMARY KEY (service_id, event_id, attempt_id, delivery_source, admission_started_at)
);

CREATE INDEX serialized_dcb_g65_admission_attempts_service_time_idx
  ON serialized_dcb_g65_admission_attempts (service_id, admission_started_at ASC, event_id COLLATE BINARY);

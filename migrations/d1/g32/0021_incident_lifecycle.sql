-- SDT-G124 manual lifecycle for global-completeness findings.
-- The finding table remains scanner-owned observation authority.

CREATE TABLE serialized_dcb_incident_lifecycles (
  service_id TEXT NOT NULL,
  incident_identity TEXT NOT NULL COLLATE BINARY,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN
    ('OPEN', 'ACKNOWLEDGED', 'CORRECTION_RECORDED', 'CLOSED', 'REOPENED')),
  owner_id TEXT,
  deadline_at INTEGER,
  correction_kind TEXT,
  correction_reference TEXT,
  correction_digest TEXT,
  close_resolution TEXT,
  close_reason TEXT,
  version INTEGER NOT NULL CHECK (version >= 0),
  last_transition_key TEXT NOT NULL COLLATE BINARY,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, incident_identity),
  FOREIGN KEY (service_id, incident_identity)
    REFERENCES serialized_dcb_completeness_findings (service_id, incident_identity)
    ON DELETE RESTRICT,
  CHECK ((owner_id IS NULL) = (deadline_at IS NULL)),
  CHECK (owner_id IS NULL OR length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 256),
  CHECK (correction_kind IS NULL OR correction_kind IN ('event', 'receipt')),
  CHECK (correction_kind IS NULL = (correction_reference IS NULL AND correction_digest IS NULL)),
  CHECK (correction_reference IS NULL OR length(CAST(correction_reference AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (correction_digest IS NULL OR
    (length(correction_digest) = 71 AND substr(correction_digest, 1, 7) = 'sha256:' AND
     substr(correction_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (close_resolution IS NULL OR close_resolution IN ('CORRECTED', 'ACCEPTED_AS_IS')),
  CHECK (lifecycle_state <> 'OPEN' OR
    (owner_id IS NULL AND deadline_at IS NULL AND correction_kind IS NULL AND
     correction_reference IS NULL AND correction_digest IS NULL AND close_resolution IS NULL AND close_reason IS NULL)),
  CHECK (lifecycle_state NOT IN ('ACKNOWLEDGED', 'REOPENED') OR
    (owner_id IS NOT NULL AND deadline_at IS NOT NULL AND correction_kind IS NULL AND
     correction_reference IS NULL AND correction_digest IS NULL AND close_resolution IS NULL AND close_reason IS NULL)),
  CHECK (lifecycle_state <> 'CORRECTION_RECORDED' OR
    (owner_id IS NOT NULL AND deadline_at IS NOT NULL AND correction_kind IS NOT NULL AND
     correction_reference IS NOT NULL AND length(CAST(correction_reference AS BLOB)) BETWEEN 1 AND 2048 AND
     correction_digest IS NOT NULL AND close_resolution IS NULL AND close_reason IS NULL)),
  CHECK (lifecycle_state <> 'CLOSED' OR
    (owner_id IS NOT NULL AND deadline_at IS NOT NULL AND close_resolution IS NOT NULL AND
     close_reason IS NOT NULL AND length(CAST(close_reason AS BLOB)) BETWEEN 1 AND 2048 AND
     ((close_resolution = 'CORRECTED' AND correction_kind IS NOT NULL AND correction_reference IS NOT NULL AND correction_digest IS NOT NULL) OR
      (close_resolution = 'ACCEPTED_AS_IS' AND correction_kind IS NULL AND correction_reference IS NULL AND correction_digest IS NULL)))
));

CREATE TABLE serialized_dcb_incident_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  incident_identity TEXT NOT NULL COLLATE BINARY,
  transition_key TEXT NOT NULL COLLATE BINARY,
  request_digest TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN
    ('ACKNOWLEDGE', 'UPDATE_ASSIGNMENT', 'RECORD_CORRECTION', 'CLOSE', 'REOPEN')),
  from_state TEXT NOT NULL CHECK (from_state IN
    ('OPEN', 'ACKNOWLEDGED', 'CORRECTION_RECORDED', 'CLOSED', 'REOPENED')),
  to_state TEXT NOT NULL CHECK (to_state IN
    ('OPEN', 'ACKNOWLEDGED', 'CORRECTION_RECORDED', 'CLOSED', 'REOPENED')),
  from_version INTEGER NOT NULL CHECK (from_version >= 0),
  to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
  actor_id TEXT NOT NULL,
  before_owner_id TEXT,
  before_deadline_at INTEGER,
  before_correction_kind TEXT,
  before_correction_reference TEXT,
  before_correction_digest TEXT,
  before_close_resolution TEXT,
  before_close_reason TEXT,
  after_owner_id TEXT,
  after_deadline_at INTEGER,
  after_correction_kind TEXT,
  after_correction_reference TEXT,
  after_correction_digest TEXT,
  after_close_resolution TEXT,
  after_close_reason TEXT,
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  UNIQUE (service_id, incident_identity, transition_key),
  FOREIGN KEY (service_id, incident_identity)
    REFERENCES serialized_dcb_completeness_findings (service_id, incident_identity)
    ON DELETE RESTRICT,
  CHECK (length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 256),
  CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (before_correction_kind IS NULL OR before_correction_kind IN ('event', 'receipt')),
  CHECK (before_correction_kind IS NULL = (before_correction_reference IS NULL AND before_correction_digest IS NULL)),
  CHECK (before_correction_reference IS NULL OR length(CAST(before_correction_reference AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (before_correction_digest IS NULL OR
    (length(before_correction_digest) = 71 AND substr(before_correction_digest, 1, 7) = 'sha256:' AND
     substr(before_correction_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (after_correction_kind IS NULL OR after_correction_kind IN ('event', 'receipt')),
  CHECK (after_correction_kind IS NULL = (after_correction_reference IS NULL AND after_correction_digest IS NULL)),
  CHECK (after_correction_reference IS NULL OR length(CAST(after_correction_reference AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (after_correction_digest IS NULL OR
    (length(after_correction_digest) = 71 AND substr(after_correction_digest, 1, 7) = 'sha256:' AND
     substr(after_correction_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK ((before_owner_id IS NULL) = (before_deadline_at IS NULL)),
  CHECK ((after_owner_id IS NULL) = (after_deadline_at IS NULL)),
  CHECK (from_state <> 'OPEN' OR
    (before_owner_id IS NULL AND before_deadline_at IS NULL AND before_correction_kind IS NULL AND
     before_correction_reference IS NULL AND before_correction_digest IS NULL AND before_close_resolution IS NULL AND before_close_reason IS NULL)),
  CHECK (from_state NOT IN ('ACKNOWLEDGED', 'REOPENED') OR
    (before_owner_id IS NOT NULL AND before_deadline_at IS NOT NULL AND before_correction_kind IS NULL AND
     before_correction_reference IS NULL AND before_correction_digest IS NULL AND before_close_resolution IS NULL AND before_close_reason IS NULL)),
  CHECK (from_state <> 'CORRECTION_RECORDED' OR
    (before_owner_id IS NOT NULL AND before_deadline_at IS NOT NULL AND before_correction_kind IS NOT NULL AND
     before_correction_reference IS NOT NULL AND before_correction_digest IS NOT NULL AND before_close_resolution IS NULL AND before_close_reason IS NULL)),
  CHECK (from_state <> 'CLOSED' OR
    (before_owner_id IS NOT NULL AND before_deadline_at IS NOT NULL AND before_close_resolution IS NOT NULL AND before_close_reason IS NOT NULL)),
  CHECK (to_state <> 'OPEN' OR
    (after_owner_id IS NULL AND after_deadline_at IS NULL AND after_correction_kind IS NULL AND
     after_correction_reference IS NULL AND after_correction_digest IS NULL AND after_close_resolution IS NULL AND after_close_reason IS NULL)),
  CHECK (to_state NOT IN ('ACKNOWLEDGED', 'REOPENED') OR
    (after_owner_id IS NOT NULL AND after_deadline_at IS NOT NULL AND after_correction_kind IS NULL AND
     after_correction_reference IS NULL AND after_correction_digest IS NULL AND after_close_resolution IS NULL AND after_close_reason IS NULL)),
  CHECK (to_state <> 'CORRECTION_RECORDED' OR
    (after_owner_id IS NOT NULL AND after_deadline_at IS NOT NULL AND after_correction_kind IS NOT NULL AND
     after_correction_reference IS NOT NULL AND after_correction_digest IS NOT NULL AND after_close_resolution IS NULL AND after_close_reason IS NULL)),
  CHECK (to_state <> 'CLOSED' OR
    (after_owner_id IS NOT NULL AND after_deadline_at IS NOT NULL AND after_close_resolution IS NOT NULL AND
     after_close_reason IS NOT NULL AND ((after_close_resolution = 'CORRECTED' AND after_correction_kind IS NOT NULL AND
     after_correction_reference IS NOT NULL AND after_correction_digest IS NOT NULL) OR
     (after_close_resolution = 'ACCEPTED_AS_IS' AND after_correction_kind IS NULL AND
     after_correction_reference IS NULL AND after_correction_digest IS NULL))))
);

CREATE INDEX serialized_dcb_incident_lifecycles_service_state_idx
  ON serialized_dcb_incident_lifecycles (service_id, lifecycle_state, owner_id, deadline_at);
CREATE INDEX serialized_dcb_incident_transitions_lookup_idx
  ON serialized_dcb_incident_transitions (service_id, incident_identity, transition_id);

CREATE TRIGGER serialized_dcb_incident_transitions_no_update
BEFORE UPDATE ON serialized_dcb_incident_transitions
BEGIN
  SELECT RAISE(ABORT, 'incident transition audit rows are immutable');
END;

CREATE TRIGGER serialized_dcb_incident_transitions_no_delete
BEFORE DELETE ON serialized_dcb_incident_transitions
BEGIN
  SELECT RAISE(ABORT, 'incident transition audit rows are immutable');
END;

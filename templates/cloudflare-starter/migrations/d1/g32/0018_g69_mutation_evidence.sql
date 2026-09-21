-- SDT-G69 F5: retain the mutation-owned first-admission witness separately
-- from the diagnostic pre-read. The admission batch populates it atomically;
-- a diagnostic receipt may never infer duplicate status from a late read.
ALTER TABLE dcb_event_ops ADD COLUMN FirstAdmissionAttemptId TEXT;
ALTER TABLE dcb_event_ops ADD COLUMN LastAdmissionAttemptId TEXT;

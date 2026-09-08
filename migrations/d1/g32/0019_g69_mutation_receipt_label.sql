-- SDT-G69 F5: expose the mutation-owned classification on the append-only
-- diagnostic receipt. A late/failed diagnostic read is never allowed to infer
-- duplicate admission.
ALTER TABLE serialized_dcb_g69_admission_attempts
  ADD COLUMN mutation_evidence TEXT NOT NULL DEFAULT 'unverified'
  CHECK (mutation_evidence IN ('first-admission', 'duplicate-admission', 'unverified'));

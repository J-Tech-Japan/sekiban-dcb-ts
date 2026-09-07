# SDT-G66 evidence

This document is the durable evidence record for issue #128. The G66 witness
uses one public, browser-equivalent session and does not alter product
behavior. Raw cohort receipts are retained under `.artifacts/` and are written
after every accepted command before visibility polling.

## Contract and guard

- `e2e:g66` sends one cold-first room/create and reservation/cancel session with
  at least ten accepted commands and at least 10 seconds between command
  responses.
- The first command for each tag is read-through; subsequent commands use a
  portable snapshot. Tag-state and public query responses are saved per
  command.
- Every command records the observed response and `x-sdt-global-admission`
  header. Every sample records unsafe and safe first visibility, per-tick
  coverage/frontier health, and tag-state/query reads.
- Missing or late observations are explicitly `censored`; the guard never
  converts a censored sample into a pass. The paused-write, missing-lane, and
  missing-coverage mutants are red-capable and exercised by
  `test/g66-e2e.spec.ts` and `scripts/g66-e2e-guard.mjs --self-test`.

## Deployment evidence

The controlled production window and before/after receipts will be appended
only from the exact retained raw files. The baseline is the deployed worker
before self-ring enablement. The candidate enables self receiver mode on the
same production worker and preserves the existing D1, Queue, DLQ, Durable
Object, and cron topology.

| phase | source/version | configuration | receipt | result |
|---|---|---|---|---|
| baseline | pending | existing normal configuration | pending | pending |
| self-ring candidate | pending | self mode and self `DOWNSTREAM_DOORBELL` binding | pending | pending |

No production cleanup is considered complete until the read-only binding and
Queue-consumer proofs are recorded immediately before each authorized removal.


# SDT-G30 — commit attribution and B0 baseline

Closes #70

## What changes

- Adds the host-owned, portable `commit-trace` authority bundle and a target
  read-only `--check` validator for `sdt.commit/v1`, reconcile, repair,
  attribute matrix, generation, and repair-link contracts.
- Instruments the existing commit, Bootstrap, Journal, Allocator, Tag, and
  Repair paths using Cloudflare active async tracing contexts. It adds no
  manual parent IDs, protocol fields, V1 diagnostics, state-machine changes,
  permits/barriers, `tagWriteResults` changes, placement, or location hints.
- Binds each B0 deployment to Cloudflare Worker Version metadata outside the
  Worker protocol; it adds no G30 conformance endpoint or runtime witness
  variable.
- Computes per-accepted-request caller-interval union attribution, observes
  activation/idle out of Durable Object storage, and adds the A/B/A′ B0
  runner, trace exporter, cohort contract, evidence recorder, and candidate
  retention gate.

## Verification

`npm run test:g30` runs the runtime trace/verifier fixtures, B0 cohort and
telemetry-anchor fixtures, manifest `--check` and mutations, exact G30 config
check, a Node/provider import-boundary probe, production-source trace mutations,
candidate-independent recorder test, and shell syntax check. CI runs this lane
plus a forced-red proof. Existing
G13–G32 lanes remain required, including the G13 five-endpoint byte oracle.

## Candidate and evidence protocol

Final C is sealed exactly once after all runtime, config, test, CI, docs,
manifest, tools, and placeholder-evidence changes are complete. C is both
deployment and digest authority. The B0 run uses that same C with placement
off, the existing G32 service ID, a single client region, fixed payload/tag,
concurrency one, and only `head_sampling_rate` 0→1→0 as the phase delta.
Phase remains an external evidence label; it is never passed to the deployed
Worker as a phase-specific variable.

R is evidence-only: `docs/SDT-G30-*evidence*.{json,md}` plus exactly one C
append in `.github/workflows/ci.yml`. The evidence states
`sourceCommit === deployedRuntimeCommit === C`, carries tree/config digests,
keeps raw A/B/A′ ledgers and B traces, requires every B trace’s individual
unattributed ratio to be at most 5%, records the A/A′ drift and B overhead
without asserting a performance pass/fail, and explicitly marks B0 as not a
G37 denominator. No token value is included in a command argument, log,
commit, or evidence artifact.

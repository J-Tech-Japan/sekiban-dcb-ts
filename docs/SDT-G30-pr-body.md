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
- Computes per-accepted-request caller-interval union attribution and emits
  an isolated `sdt.observe/v1` Workers Logs stream for facts that cannot fit
  the sealed commit-span schema (Worker isolate, DO handler/storage/subrequest
  measurements, and bounded doorbell test seams). Worker logs retain the
  provider CF-Ray and existing correlation; DO logs retain provider request
  identity and existing attempt correlation. The exporter joins the client's
  POP-suffixed CF-Ray through Cloudflare's 16-hex provider Ray index and
  restores the original client value in evidence; it uses bounded ten-value
  subqueries whose values are serialized as the provider's comma-separated
  `in` membership form and are structurally limited to the provider's 16
  filter-node maximum. The initial query and every subsequent incomplete
  cohort query, including a found-but-incomplete success trace, retry only
  until the canonical ten-minute deadline; a
  saturated page is rejected rather than accepted as partial telemetry. The A/B/A′
  runner, cohort contract, evidence recorder, and candidate retention gate join
  every retained observation to the B ledger and S00 root. Human
  activation/outlier records are rejected; refresh, idle, and queue/doorbell
  disposition are calculated from raw telemetry and client timelines only.
- Defers Worker isolate randomness to the first request-handler boundary,
  which preserves per-isolate tracing while keeping the local workerd module
  loader free of forbidden global-scope random generation. CI retains the G15
  Wrangler log when the local Worker startup lane fails.

## Verification

`npm run test:g30` runs the runtime trace/verifier fixtures, B0 cohort and
telemetry-anchor fixtures, manifest `--check` and mutations, exact G30 config
check, a Node/provider import-boundary probe, production-source trace mutations,
candidate-independent recorder test, and shell syntax check. CI runs this lane
plus a forced-red proof. Existing
G13–G32 lanes remain required, including the G13 five-endpoint byte oracle and
the G26 correlation-log fixture that proves unrelated structured observation
events cannot weaken the doorbell diagnostic oracle.

## Candidate and evidence protocol

Final C is sealed exactly once after all runtime, config, test, CI, docs,
manifest, tools, and placeholder-evidence changes are complete. C is both
deployment and digest authority. The B0 run uses that same C with placement
off, the existing G32 service ID, a single client region, fixed payload/tag,
concurrency one, and only `head_sampling_rate` 0→1→0 as the phase delta.
Before each phase, the client performs an indexed durable read of the fixed
tag head and carries it through ordinary sequential consistency reservations,
advancing from each accepted response. That client-side head is not a phase
configuration delta or an evidence declaration; a one-time seed is permitted
only for an otherwise empty service and is outside all phase ledgers. Phase
remains an external evidence label; it is never passed to the deployed Worker
as a phase-specific variable.

R is evidence-only: `docs/SDT-G30-*evidence*.{json,md}` plus exactly one C
append in `.github/workflows/ci.yml`. The evidence states
`sourceCommit === deployedRuntimeCommit === C`, carries tree/config digests,
keeps raw A/B/A′ ledgers, B traces, and structured observations, requires every B trace’s individual
unattributed ratio to be at most 5%, records the A/A′ drift and B overhead
without asserting a performance pass/fail, and explicitly marks B0 as not a
G37 denominator. No token value is included in a command argument, log,
commit, or evidence artifact.

The remote migration preflight first verifies the sealed config's exact D1
`database_id`, `database_name`, and `migrations_dir` values, then calls
Wrangler through the verified `D1` and `D1_MV` binding aliases. Direct
durable-name lookup is not an authorized operation in this account; its
redacted HTTP 403/code-7403 result is retained as diagnostic evidence only.

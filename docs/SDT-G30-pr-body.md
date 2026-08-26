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
- Computes caller-interval union attribution for every schema-complete joined
  request; a provider-delivery miss is enumerated as UNKNOWN rather than
  counted as an absence or a pass. It emits
  an isolated `sdt.observe/v1` Workers Logs stream for facts that cannot fit
  the sealed commit-span schema (Worker isolate, DO handler/storage/subrequest
  measurements, and bounded doorbell test seams). Worker logs retain the
  provider CF-Ray and existing correlation; DO logs retain provider request
  identity and existing attempt correlation. The exporter joins the client's
  POP-suffixed CF-Ray through Cloudflare's 16-hex provider Ray index and
  restores the original client value in evidence. When a custom S00 root has
  no provider Ray, it uses only that existing worker correlation to query one
  exact traceId; ambiguity fails and time-proximity fallback is forbidden. It
  uses bounded ten-value discovery and observation subqueries whose values
  are serialized as the provider's comma-separated `in` membership form and
  are structurally limited to the provider's 16 filter-node maximum. Each
  full-trace expansion is one exact traceId: the provider saturated a
  four-trace expansion at 2,000 results while every single trace was below
  that cap, so batching cannot hide a valid cohort. The initial query and every subsequent incomplete
  cohort query, including a found-but-incomplete success trace, retry only
  until the canonical ten-minute deadline; a
  saturated page is rejected rather than accepted as partial telemetry. The A/B/A′
  runner retains the original 100-request client ledger as the fixed universe:
  `schemaCompleteCount >= 95`, all six-or-more losses fail, and every missing
  identity records its `root-absent` or `schema-incomplete` stage. The exact
  rank-1..5 tail is ordered by client latency descending then request ID
  ascending and may not be missing. Full-ledger p50/p95/p99 use the sealed
  nearest-rank estimator; joined per-hop values are conditional and retain a
  sensitivity envelope. Human
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

Immediately after each primary version deployment, only a transient 403 on
that authenticated initial head read is retried with the fixed 15×1s
secret-propagation bound. A 500 or any other read failure is still captured
with its conformance response detail and fails closed; the retry neither
changes the V1 wire nor treats a failed command as a sample replacement.

Within a phase's eligible 100-request window, a timeout or any non-200 commit
is indeterminate rather than a retryable replacement. The measuring helper
retains its redacted raw response/transport record, CF-Ray and timestamps,
reads the fixed tag again, and discards the provisional window. It does not
resend that attempt; only a new independent attempt may begin a new window
from the durable reread. A missing, regressing, or unreadable reread fails
closed, and more than five resets retains the reset distribution then stops.

R is evidence-only: `docs/SDT-G30-*evidence*.{json,md}` plus exactly one C
append in `.github/workflows/ci.yml`. The evidence states
`sourceCommit === deployedRuntimeCommit === C`, carries tree/config digests,
keeps raw A/B/A′ ledgers, the full 100-request B client universe, B traces,
and structured observations. It requires each schema-complete joined B trace’s
individual unattributed ratio to be at most 5%, enumerates UNKNOWN delivery
loss and tail coverage, records full-ledger nearest-rank client percentiles,
and labels joined per-hop values as conditional with their sensitivity envelope.
It records the A/A′ drift and B overhead
without asserting a performance pass/fail, and explicitly marks B0 as not a
G37 denominator. No token value is included in a command argument, log,
commit, or evidence artifact.

The remote migration preflight first verifies the sealed config's exact D1
`database_id`, `database_name`, and `migrations_dir` values, then calls
Wrangler through the verified `D1` and `D1_MV` binding aliases using that
config's repo-root absolute path. A cwd-relative config invocation is a
separate rejected mutation, since Wrangler can otherwise resolve it
inconsistently. Direct durable-name lookup is not an authorized operation in
this account; its redacted HTTP 403/code-7403 result is retained as diagnostic
evidence only.

# SDT-G69 safety evidence

This document records the local safety half of SDT-G69/#133. Issue #133 remains
open and AC4/AC5 remain outstanding. This checkpoint does not implement the
first-arrival fence, change SafeWindow, retries, drain behavior, deployment or
production configuration, or perform a production cohort.

## Consultation-003 disposition

The consultation-003 option chosen here is **validated generation-scoped
fail-closed quarantine** for a proven strict-order incident. It is the smallest
option that protects public safe reads without changing G44/G62 frontier
certification or pretending that a diagnostic receipt proves allocator closure.
The local tests validate the persistence, public response, unsafe-read escape,
and rebuild/promotion recovery path. No deployment claim is made until a later
unit supplies deployed evidence.

The prior engineering recommendation is retained verbatim as a recorded
dissent/history, not silently rewritten:

> It is not safe to implement the first-arrival fence in this checkpoint. The
> proof allocated a lower-SUID and a higher-SUID candidate in one allocator
> request (one allocator lineage), appended/delivered the higher candidate
> first, and ran the actual safe-lane path without injecting a `SETTLED` result.
> G44 reported the normal `BLOCK/UNSETTLED` intermediate state and the real safe
> pass later recorded `SETTLED`/completed for the higher event. The lower
> candidate was then appended and delivered; the lower SUID arrived after the
> projection checkpoint. The new detector recorded `LATE_LOWER_SUID`, appended
> an ordering incident, and made the subsequent safe pass fail closed.
>
> No first-arrival fence, SafeWindow change, retry/drain change, G44/G62
> semantic change, production change, or G32 change was made. The live defect
> is preserved for the G69 design decision rather than hidden by a synthetic
> `SETTLED` result.

The dissent remains correct about the fence decision: the first-arrival fence
is not implemented. The added quarantine protects the already-proven safe
reader when the detector observes the counterexample; it does not certify an
allocator-to-source ordering premise.

## AC1: structural allocator witness, not a production incident

The local proof uses one real allocator request for a lower-SUID and a
higher-SUID candidate. It then directly appends the higher candidate to Tag,
keeps the lower candidate held, disables automatic outbox draining, delivers
the higher message through the real Queue/D1 path, runs the real G44/G62 safe
lane, and only then appends/delivers the lower candidate. The higher arrival is
backdated by 60 seconds to accelerate the SafeWindow in the test. No coverage
result is injected and no production incident is inferred from this witness.

Observed result: G44 first exposes its normal `BLOCK/UNSETTLED` state; the
higher event can become safe after the real settled pass; the later lower event
is detected as `LATE_LOWER_SUID`. The detector writes a durable
`ORDER_VIOLATION` incident and a generation-scoped quarantine. The local
coordinator’s safe-lane alarm route returns 404 in this Miniflare setup; that is
an environment-only alarm receipt, not a deployed scheduling result.

## AC2: detector and quarantine semantics

`D1EventStore.findLateLowerSuid` now identifies a lower SUID whose **first
durable normal-delivery arrival** is strictly after the active MV checkpoint
clock. It does not promote imported or repaired history to an ordering witness,
does not treat equal-millisecond arrival as later, requires a non-rolled-back
arrival pair, and preserves the first-arrival value on replay. The intended
late-lower lag-estimate repair is a safety/latency change, not happy-path
neutral: a lower-SUID arrival is no longer discarded merely because a higher
SUID already exists, so the decayed estimate can represent that observed lag.
The focused local measurement records the lower/replayed observation in the
estimate (`estimate_ms=2000`, `observed_at=11000` in the deterministic test),
and the old higher-SUID exclusion mutant is red.

On detection, the safe-lane catch-up path appends the existing delivery
incident and persists `mv_ordering_quarantines` keyed by
`service_id/view_id/generation`, with checkpoint SUID, late SUID, event ID,
classification, and observed time. A structured
`SDT-G69_ORDERING_QUARANTINE` error log is emitted for alerting. The public D1
MV safe query validates the active-generation row and returns HTTP 503 with
`code=projection_ordering_quarantined` before exposing a safe result. An
explicit unsafe read remains available for diagnosis; it does not certify the
safe lane.

Recovery is explicit: a rebuilt candidate generation is promoted atomically
with the active-generation pointer, and open quarantine rows on older
generations are marked resolved in that same batch. The new generation must be
rebuilt/promoted; no read path clears the quarantine. The local public-read
test proves the typed 503/unsafe distinction, and the ordering proof proves the
durable incident/quarantine. This is a validated local fail-closed path, not a
deployed alert or recovery claim.

The detector has explicit false-positive coverage for:

- equal-millisecond arrival (`FirstArrivedAt > checkpointUpdatedAt` is strict);
- delayed DB admission or a replay whose first durable arrival was earlier;
- a later checkpoint-clock overwrite;
- replay preserving `MIN(FirstArrivedAt)` while increasing `LastArrivedAt`;
- a clock rollback where `FirstArrivedAt > LastArrivedAt`;
- imported or repaired timestamps whose source provenance is `unknown`/`import`;
- generation transition, where promotion resolves only the old generation’s
  quarantine.

## AC3: non-blocking admission-attempt receipt

The `serialized_dcb_g69_admission_attempts` ledger remains diagnostic only.
`recordDelivery` starts the before-read concurrently, completes core admission,
then schedules best-effort receipt observation outside the awaited core path.
The receipt records before/after arrival values, observation clocks, an explicit
`observation_consistency` classification, status and retry reason. A stalled
diagnostic hook therefore cannot delay core admission or Queue disposition.
Retention is bounded to the newest 512 rows per service in the same diagnostic
batch. The receipt is not an allocation-closure proof and is not read by
DeliveryCore, Queue retry/DLQ logic, G44 coverage, MV catch-up or public query.
The non-blocking test holds the diagnostic hook pending while core admission
returns, and the receipt-omission plus awaited-receipt mutants are red.

## Preserved boundaries and status

The six existing SDT-G60 mutants are unchanged. SafeWindow, G44/G62 frontier
semantics, Queue disposition/retry/drain behavior, the first-arrival-fence
decision, deployment/production resources and G32 resources are unchanged.
AC4/AC5 are not claimed; the PR references #133 rather than closing it.

The W164 allocator witness and the W166 repair are local structural evidence.
It does not establish zero production detections, deployed safe-read behavior,
or an allocation-to-arrival bound. Those require the later G69 acceptance work.

## Verification

Passing focused checks at the W166 source:

- `npm run test:g69`: baseline green; four mutants red and restored:
  omitted late-lower detector, restored higher-SUID lag exclusion, omitted
  append-only receipt, and awaited diagnostic receipt on the core path.
- `vitest run --config vitest.g69.config.ts --no-cache --maxWorkers=1
  test/g55-read-visibility.spec.ts test/g69-ordering.spec.ts`: 2 files, 8
  tests passed.
- `npm run build --workspace packages/dcb-runtime`: pass.

The full CI-equivalent lane set is required before the repair push. The known
isolated-worktree exception remains separate: workspace aggregate
`build:packages`/typecheck can resolve stale parent declarations and report
`ExecuteCommandResult`, `SnapshotReader.head`, and already-landed G60/G65/G67
exports/options as missing. Such lanes are recorded as blocked environment
exceptions and are never called green; no unrelated package or sample change
is used to mask them. Hosted exact-head CI must be green before rereview.

The complete red/green receipt remains at
`.artifacts/sdt-g69-ordering-red-green.json`. Earlier W164/W165 receipts remain
historical records and are not replaced by this consultation correction.

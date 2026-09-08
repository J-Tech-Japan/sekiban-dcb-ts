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

`D1EventStore.findLateLowerSuidEvidence` now reports a structured
`late-lower-suid`, `replay`, `miss`, or `unknown` result for a lower SUID whose
**first durable normal-delivery arrival** is strictly after the active MV
checkpoint clock. The detector is exercised through the real allocator-to-Tag-
to-D1 path and the public safe behavior; it is not a synthetic SETTLED result.
It does not promote imported or repaired history to an ordering witness, does
not treat equal-millisecond arrival as later, requires a non-rolled-back
arrival pair, and preserves the first-arrival value on replay. Rollback,
invalid checkpoint state, and untrusted provenance remain `unknown` and are
incident/alarm-only rather than an unsafe refusal. The intended late-lower
lag-estimate repair is a safety/latency change, not happy-path neutral: a
lower-SUID arrival is no longer discarded merely because a higher SUID already
exists, so the decayed estimate can represent that observed lag.
The focused local measurement records the lower/replayed observation in the
estimate (`estimate_ms=2000`, `observed_at=11000` in the deterministic test),
and the old higher-SUID exclusion mutant is red.

On detection, the safe-lane catch-up path appends the existing delivery
incident and persists `mv_ordering_quarantines` keyed by
`service_id/view_id/generation`, with checkpoint SUID, late SUID, event ID,
classification, and observed time. A structured
`SDT-G69_ORDERING_QUARANTINE` error log is emitted for alerting. The public D1
MV safe query validates the active-generation row and returns HTTP 503 with
`code=projection_ordering_quarantined` before exposing a safe result. The
generation is checked again at the read boundary after `waitFor`; a quarantine
that appears while the read is waiting therefore returns the same typed 503
instead of a stale safe result. An explicit unsafe read remains available for
diagnosis; it does not certify the safe lane. A generation transition cannot
clear an open quarantine until a complete, incident-bound rebuild from the
real source/rebuild path is marked verified. An incomplete source history,
stale proof, or candidate whose checkpoint does not match that history is
rejected. Empty materialized output is valid when the complete source history
was applied and the materializer legitimately deletes every row. The recovery
test proves that a complete rebuild restores safe reads and that
old-generation quarantine does not leak into a new generation.

Recovery is explicit: a rebuilt candidate generation is promoted atomically
with the active-generation pointer, and open quarantine rows on older
generations are marked resolved in that same batch. The new generation must be
rebuilt/promoted; no read path clears the quarantine. The local public-read
tests prove the typed 503/unsafe distinction, wait-boundary quarantine, and
generation consistency; the ordering proof proves the durable
incident/quarantine, complete source-history binding, valid empty output,
stale-proof invalidation, and formerly skipped rows restoring safe reads. This
is a validated local fail-closed path, not a deployed alert or recovery claim.

The detector has explicit false-positive coverage for:

- equal-millisecond arrival (`FirstArrivedAt > checkpointUpdatedAt` is strict);
- delayed DB admission or a replay whose first durable arrival was earlier;
- a later checkpoint-clock overwrite;
- replay preserving `MIN(FirstArrivedAt)` while increasing `LastArrivedAt`;
- a clock rollback where `FirstArrivedAt > LastArrivedAt`;
- imported or repaired timestamps whose source provenance is `unknown`/`import`;
- generation transition, where only a verified promotion bound to the old
  incident resolves the old generation’s quarantine; a malformed generation
  context is alarm-only.

## AC3: non-blocking admission-attempt receipt

The `serialized_dcb_g69_admission_attempts` ledger remains diagnostic only.
`recordDelivery` performs no diagnostic pre-read and does not await the
mutation-evidence query. It completes the durable core admission first, then
schedules best-effort receipt observation through the invocation's `waitUntil`
lifetime (or a detached promise in the local store test), outside the awaited
core path. The receipt keeps the actual nullable Queue wrapper ID separate from
the envelope `attempt_id`, records the post-admission arrival values, observed
clocks, an explicit `observation_consistency` classification, and honest
`stored`/`duplicate`/collision/`failed` statuses plus retry reason. The
`diagnostic_duration_ms` field records the per-attempt diagnostic and receipt
preparation cost before the append is issued; it is not an admission clock.
Consequently concurrent and replayed deliveries are distinguishable, a
diagnostic failure remains best-effort, and a stalled receipt cannot delay core
admission or Queue disposition. Retention is bounded to the newest 512 rows per
service in the same diagnostic batch. The receipt is not an allocation-closure
proof and is not read by DeliveryCore, Queue retry/DLQ logic, G44 coverage, MV
catch-up or public query. The focused tests cover omitted and awaited-receipt
mutants, failure, concurrency, replay, retention, and a non-negative persisted
per-attempt cost.

The late-lower detector is called once before the event-application loop for
each catch-up pass. Its normal D1 path uses bounded `LIMIT 1` proven, unknown,
and replay probes rather than materializing every lower-SUID row or issuing an
N+1 event lookup. The resulting `lateLowerQueryDurationMs` is carried in each
materialized-view observation and therefore in the durable
`catch_up_result_json` pass ledger. A proven lower-SUID witness is queried
before unknown evidence so an uncertain row cannot hide a real violation. These
diagnostics measure and attribute hot-path cost only; they do not provide
allocator closure, ordering proof, or permission to relax G44/G62.

## Preserved boundaries and status

The six existing SDT-G60 mutants are unchanged. SafeWindow, G44/G62 frontier
semantics, Queue disposition/retry/drain behavior, the first-arrival-fence
decision, deployment/production resources and G32 resources are unchanged.
AC4/AC5 are not claimed; the PR references #133 rather than closing it.

The W164 allocator witness and the W166-2 repair are local structural evidence.
It does not establish zero production detections, deployed safe-read behavior,
or an allocation-to-arrival bound. Those require the later G69 acceptance work.

## W167: G67 AC3 hot-path repair

The hosted G44 failure at exact pre-repair head `946ffe6` was the unchanged
G67 AC3 5,000 ms guard at `test/g67-safe-lane.spec.ts:731`. The G69 path was
causal: `recordDeliveryCore` awaited an admission-mutation diagnostic pre-read,
and the late-lower detector performed a full scan plus per-row lookups. Neither
diagnostic was part of durable admission, but both ran on the delivery path.

W167 removes that awaited work without changing admission semantics. Core
admission now returns after the durable mutation; the diagnostic receipt is
post-admission, best-effort and attached to the invocation lifetime through
`waitUntil` (or a detached promise in local tests). The receipt records the
nullable post-admission mutation result and `diagnostic_duration_ms`; it is
bounded diagnostic retention and explicitly provides no allocation closure.
The late-lower detector runs once before each catch-up event loop, uses bounded
proven/unknown/replay `LIMIT 1` probes in proven-first order, and carries its
observed `lateLowerQueryDurationMs` through `catch_up_result_json`. It is also
diagnostic only and does not change G44/G62 certification.

The focused W167 receipt observed diagnostic receipt cost `1 ms`, and detector
costs `0–1 ms` (`detectorCalls=1` for a two-event follow-up pass). These are
local observed clocks, not a production allocation or latency guarantee. The
unchanged `npm run test:g67` command now passes its 11/11 behavior tests; all
seven existing G67 mutation probes remain red. No G67 assertion, budget,
timeout, scheduler, fence, SafeWindow, retry or drain behavior was changed.

## Verification

Passing focused checks at the W167 source:

- `npx vitest run test/g69-ordering.spec.ts --pool=forks --maxWorkers=1
  --no-file-parallelism`: 1 file, 6 tests passed. This covers the real
  allocator-to-Tag-to-D1 witness, mixed unknown/proven detector scanning,
  decreasing-timestamp MIN replay, generation/public-read clocks, typed
  quarantine during `waitFor`, complete real rebuild recovery (including
  valid empty output), stale/incomplete proof rejection, and diagnostic
  failure/concurrency/replay/retention.
- `npx vitest run test/g31-waitfor.spec.ts test/g55-read-visibility.spec.ts
  --pool=forks --maxWorkers=1 --no-file-parallelism`: 2 files, 30 tests
  passed, including timeout-quarantine and generation-change boundary reads.
- `npm run test:g69`: green; four accepted mutants are red: omitted
  late-lower detector, restored higher-SUID lag exclusion, omitted append-only
  receipt, and awaited diagnostic receipt on the core path.
- `npm run test:g44`: contract and 8 tests passed; all G44 production mutants
  red.
- `npm run test:g43`: 3 files, 20 tests passed; the five production mutants
  were red. The output includes the known G43 crash/teardown diagnostics, but
  the command exited 0.
- `npm run test:g60:required`: direct 14 tests, unsafe-writer 4 tests, and
  all Queue/durable-hop/post-admission checks passed; all six unchanged G60
  mutants were red.
- `npm run test:g61`: green guard, pre-fix probe red, and mutant probe red.
- `npm run test:g62`: green guard and all scheduled-maintenance mutants red.
- `npm run test:g65`: 17 tests passed; G65 guard and its six mutants remained
  red as expected.
- `npx vitest run test/g67-safe-lane.spec.ts --pool=forks --maxWorkers=1
  --no-file-parallelism` and the unchanged `npm run test:g67`: 11/11 behavior
  tests passed and all seven mutation probes were red. The earlier exact-head
  timeout is retained as the causal pre-repair receipt; it is not used to
  relax the 5,000 ms guard.
- `npm run typecheck` and `npm run lint`: pass after the final source edits.

The cache-corrected full aggregate was run as
`NPM_CONFIG_CACHE=/private/tmp/sdt-g69-npm-cache npm run check`. It passed
lint, typecheck and all G28 boundary gates, then stopped in the default
parallel `npm test` stage: 90 files passed, 4 failed, 1 skipped (788 passed,
5 failed, 1 skipped). The five failures were the existing 5-second/default
parallel timing signatures in `test/commit.spec.ts` AC7, `test/g67-safe-lane.spec.ts`
AC3, `test/repair.spec.ts` (15-second crash/race sweep and 5-second checkpoint),
and `test/tag.spec.ts` G5. The G43 alarm race is separately covered by the
focused command above. No failure identified a G69 assertion; no timeout or
fixture was weakened.

`npm run test:g58` passed its 5 files/15 tests and earlier guards, then stopped
at the existing `scripts/g58-safe-lane-diagnosis-guard.mjs` W96 witness:
`same-tick frontier witness remains red (exit null); inspect
.artifacts/sdt-g58-w97-green-guard.json`. This is a G58 runner/environment
exception outside this repair, not called green and not modified here. The
known isolated-worktree stale-parent exception remains separately documented:
an aggregate `build:packages`/typecheck in that context can report missing
`ExecuteCommandResult`, `SnapshotReader.head`, and already-landed
G60/G65/G67 exports/options. No unrelated package or sample change masks an
exception. Hosted exact-head CI is required before rereview.

The complete red/green receipt remains at
`.artifacts/sdt-g69-ordering-red-green.json`. Earlier W164/W165 receipts remain
historical records and are not replaced by this consultation correction.

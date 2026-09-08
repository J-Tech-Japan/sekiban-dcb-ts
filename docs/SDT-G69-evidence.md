# SDT-G69 safety evidence

This document records the local safety half of SDT-G69/#133. Issue #133 remains
open and AC4/AC5 remain outstanding. This checkpoint does not implement the
first-arrival fence, change SafeWindow, retries, drain behavior, deployment or
production configuration, or perform a production cohort.

## W169 active scope

The W169 landing is deliberately smaller than the earlier consultation-003
proof work. It retains only the qualified structural AC1 witness, the bounded
append-only admission-attempt receipt off the awaited delivery path, and the
late-lower query as an explicit proof-only opt-in. The detector is disabled on
every production safe-lane trigger, so it is not claimed to protect deployed
safe reads. The receipt and proof-only detector have measurable cost; neither
is described as free or as allocator closure. AC4/AC5 remain open.

## Consultation-003 disposition (historical proof)

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
is not implemented. The local quarantine behavior is retained as an explicit
proof/recovery result only; because the detector is disabled on production
safe-lane triggers, this checkpoint makes no deployed safe-reader protection
claim and does not certify an allocator-to-source ordering premise.

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

## AC2: detector and quarantine semantics (proof-only opt-in)

`D1EventStore.findLateLowerSuidEvidence` now reports a structured
`late-lower-suid`, `replay`, `miss`, or `unknown` result for a lower SUID whose
**first durable normal-delivery arrival** is strictly after the active MV
checkpoint clock. The detector is exercised through the real allocator-to-Tag-
to-D1 path and the public safe behavior; it is not a synthetic SETTLED result.
It does not promote imported or repaired history to an ordering witness, does
not treat equal-millisecond arrival as later, requires a non-rolled-back
arrival pair, and preserves the first-arrival value on replay. Rollback,
invalid checkpoint state, and untrusted provenance remain `unknown` and are
incident/alarm-only rather than an unsafe refusal. W168 removes the G69
lag-estimate change: the D1 estimator again excludes a delivery when a higher
SUID already exists for the service. The deterministic replay test therefore
retains the earlier estimate (`estimate_ms=1000`, `observed_at=2000`) instead
of letting the lower/replayed observation raise it. The restored higher-SUID
exclusion mutant is red. This preserves the existing public high-lag
fail-closed behavior; no lag estimate or SafeWindow contract was changed.

When the proof-only detector is explicitly enabled, the safe-lane catch-up path
appends the existing delivery
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
is a validated local proof-only fail-closed path, not a deployed alert,
safe-lane protection, or recovery claim.

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

## W167 F1: real generation and public-reader clock proof

The former named-clock checks were not sufficient because they called the
detector with literal checkpoint clocks. The bounded F1 repair adds a separate
real-D1 matrix in `test/g69-ordering.spec.ts`. Each case creates a real
`ReservationProjector` generation, admits source rows through
`D1EventStore.recordDelivery`, applies or follows the generation through
`MaterializedViewCatchUpRuntime`, reads the resulting checkpoint and detector
classification from durable state, and crosses the public V1
`handleSerializedQuery` boundary against the same D1 MV. No test supplies a
detector checkpoint as a substitute for generation application.

| schedule | generation/checkpoint assertion | detector classification | durable quarantine | public safe / unsafe status |
| --- | --- | --- | --- | --- |
| captured-before-admission | generation 0 remains at the higher SUID | `miss` | absent | 200 / 200 |
| equal-millisecond | generation 0 remains at the higher SUID | `miss` | absent | 200 / 200 |
| checkpoint overwrite | generation 0 advances to the later higher SUID through a second real follow | `miss` | absent | 200 / 200 |
| decreasing replay | generation 0 remains at the higher SUID; FirstArrivedAt remains the earlier observed value | `replay` | absent | 200 / 200 |
| clock rollback | generation 0 remains at the higher SUID | `unknown` (`arrival-clock-rollback` alarm) | absent | 200 / 200 |
| genuine late-lower control | generation 0 remains at the higher SUID | `late-lower-suid` | open generation-bound quarantine | typed 503 `projection_ordering_quarantined` / 200 |

The late-lower control is the genuine refusal oracle: the lower event is
admitted after the higher generation checkpoint with a later observed first
arrival, the real follow persists the ordering incident/quarantine, the safe
reader returns the typed 503, and the explicit unsafe reader remains usable.
Every row asserts the generation, classification, quarantine presence or
absence, and both public statuses.

The schedule uses deterministic injected observed arrival times at the real
`recordDelivery` boundary so the cases run quickly and repeatably; it is not a
claim about wall-clock production timing. The normal D1 admission path cannot
produce a rollback pair because it preserves FirstArrivedAt MIN and LastArrivedAt
MAX, so the rollback case uses an explicit imported/repair-style SQL clock
corruption after a real generation checkpoint and verifies the resulting
alarm-only `unknown` classification. This limitation is recorded rather than
presented as a production clock incident. No runtime, SafeWindow, fence,
retry, drain, or G67 behavior changed in this proof-only repair.

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

The late-lower detector is not on any production safe-lane path in the final
W168 shrink: Queue/delivery, fence-expiry, coverage-retry, and cron kicks all
pass `runOrderingDetector=false`, so their `lateLowerQueryDurationMs` is `0`;
the existing in-batch strict-order check still preserves the fail-closed incident
and quarantine boundary when a lower row is directly present in that source
batch. The explicit `runOrderingDetector=true` option is retained only for
isolated scheduled-maintenance proof tests. Those tests use one bounded `LIMIT
1` proven/unknown/replay probe before their event-application loop rather than
materializing every lower-SUID row or issuing an N+1 event lookup. Their
observed `lateLowerQueryDurationMs` is the measured scheduled-proof cost, not a
production latency budget. A proven lower-SUID witness is queried before
unknown evidence so an uncertain row cannot hide a real violation. The
diagnostic receipt and detector provide no allocator closure, ordering proof
beyond their stated incident boundary, or permission to relax G44/G62.

## Preserved boundaries and status

The six existing SDT-G60 mutants are unchanged. SafeWindow, G44/G62 frontier
semantics, Queue disposition/retry/drain behavior, the first-arrival-fence
decision, deployment/production resources and G32 resources are unchanged.
AC4/AC5 are not claimed; the PR references #133 rather than closing it.

The W164 allocator witness and the W166-2 repair are local structural evidence.
It does not establish zero production detections, deployed safe-read behavior,
or an allocation-to-arrival bound. Those require the later G69 acceptance work.

## W167 (historical): G67 AC3 hot-path repair

The hosted G44 failure at exact pre-repair head `946ffe6` was the unchanged
G67 AC3 5,000 ms guard at `test/g67-safe-lane.spec.ts:731`. The G69 path was
causal: `recordDeliveryCore` awaited an admission-mutation diagnostic pre-read,
and the late-lower detector ran on every delivery-path catch-up. Neither
diagnostic was part of durable admission, but both ran on the delivery path.

W167 removes that awaited work without changing admission semantics. Core
admission now returns after the durable mutation; the diagnostic receipt is
post-admission, best-effort and attached to the invocation lifetime through
`waitUntil` (or a detached promise in local tests). The receipt records the
nullable post-admission mutation result and `diagnostic_duration_ms`; it is
bounded diagnostic retention and explicitly provides no allocation closure.
W168 first moved the late-lower detector out of every kicked production
safe-lane catch-up. The exact follow-up hosted run still timed out the
unchanged G67 AC3 guard, so the final shrink also removes it from the
production cron backstop. The explicit `runOrderingDetector` option remains
only for isolated ordering proof tests; Queue, delivery, fence-expiry,
coverage-retry, and cron passes do not execute the detector query. The
in-batch strict-order check and G44/G62 certification remain unchanged.

The focused receipt observed diagnostic receipt cost `1 ms`; isolated detector
proof measured `0–1 ms` on its scheduled follow-up and `0 ms` on the Queue
trigger. These are local observed clocks, not a production allocation or
latency guarantee. The unchanged local `npm run test:g67` command passes its
11/11 behavior tests and all seven mutation probes remain red, but hosted exact
run `34192281814` timed out the unchanged G67 AC3 at 5,000 ms in foundation job
`101952616110`. Under WAKE-168 this is the measured unaffordability receipt:
the detector is removed from the production cron path too. No G67 assertion,
budget, timeout, scheduler, fence, SafeWindow, retry or drain behavior was
changed.

## W168 shrink repair and retained CI receipts

The W168 source repair starts from exact PR head
`ca404bb77ee9b79713d40cdf358478adc1c5c566`. It restores the pre-G69 D1
high-SUID lag-estimate exclusion and makes `test/read.spec.ts` remain unchanged;
the public high-lag fail-closed expectation remains HTTP 500. The late-lower
detector is disabled on every production safe-lane trigger, including cron;
its explicit runtime option is retained only for isolated ordering proof.
Queue, fence-expiry, and coverage-retry passes retain the existing catch-up and
fail-closed in-batch order check without paying the detector query. No G67
timeout/assertion was changed. The bounded append-only admission-attempt
receipt remains off the awaited delivery path and is diagnostic-only with
bounded retention; it does not provide allocation closure.

The unchanged local G67 AC3 guard passes (`11/11` behavior tests; seven
mutation probes red), but hosted run `34192281814` timed out that unchanged
5,000 ms guard in foundation job `101952616110`. The detector is therefore
removed from production scheduled maintenance too; the isolated detector cost
measurements are not treated as a deployable budget. AC4/AC5 remain outstanding
and issue #133 remains open/referenced.

The previous exact-head hosted run `34188299398` is retained as C-14 evidence
for the shrink decision:

- G46 public fail-closed regression: [job 101940978295](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978295), step `Run SDT-G46 bounded TagState cache/replay lane` failed.
- G44 G67 5,000 ms guard timeout: [job 101940978323](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978323), step `Run SDT-G67 event-driven safe-lane kick lane` failed.
- G43 C-14 exception: [supplied job URL](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978202). At capture time the run was still in progress and failure logs were unavailable; GitHub's job metadata labels that supplied job `ci-foundation`, while the packet classifies it as the G43 C-14 exception. This is recorded verbatim rather than relabeled.

The exact-head hosted run
[34193530512](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34193530512)
tested repair source head `54b87fdeae438cb262d92880d34da36ca8fcf400` and
finished `SUCCESS` with 20/20 jobs, including aggregate `verify` job
`101966143727`. The relevant required jobs were foundation
`101956289524`, G44 `101956289645`, G46 `101956289740`, G43
`101956289635`, and both G30 jobs `101956289691` and `101956289702`.
The long G30 jobs eventually reached terminal success; no C-14 failure
remained on the exact head. This paragraph is an evidence-only follow-up
after exact CI. No deployment, production operation, resource mutation,
fence/SafeWindow/retry/drain change, or G32 operation was performed.

The first exact-head run for the pushed shrink (`34190275690`, head
`26afcb770969edeaaf485717625deca3b39016fb`) exposed two compatibility
regressions in addition to its unrelated long-running G30/G32 jobs. The
foundation job `101946742429` and local-e2e job `101946742743` both failed the
existing `test/d1-mv.spec.ts` `ORDER_VIOLATION` case because the detector is no
longer implicit on a direct runtime build. That test is now an explicit
scheduled-detector invocation; the production Queue/fence kick remains
detector-free. The G44 job `101946742569` failed only because the unchanged
G58 W105 static guard no longer found the exact retained-frontier follow line
after the option expansion; the non-detector branch now preserves that exact
source shape. These are repaired compatibility findings, not softened
assertions or gate changes.

## W169 review repair

W169 restores the pre-existing unconditional pre-apply source-batch SUID walk.
Every default/runtime catch-up path now rejects an unordered batch, appends the
existing `ORDER_VIOLATION` incident, and records the same fail-closed quarantine
before applying any row. The existing G19 default-configuration regression
remains unchanged; the new G69 guard mutant removes this unconditional call and
the default test turns red. Only the new late-lower database query is gated by
`runOrderingDetector`, and it remains off for Queue/delivery, fence-expiry,
coverage-retry and cron production paths.

The D1 lag-estimator SQL now matches the PR base semantics exactly, including
`observed_at = excluded.observed_at`; the higher-SUID exclusion also matches
base. `test/read.spec.ts` is unmodified and retains the public high-lag HTTP
500 behavior. No SafeWindow, fence, retry, drain, G67 assertion or timeout
changed.

The additions retain measurable diagnostic/proof cost and make no safe-lane
protection claim for the off-production detector. The qualified structural AC1
witness and bounded off-awaited admission receipt remain the only active G69
evidence surfaces. Historical regression receipts remain explicit: [G46 job
101940978295](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978295)
recorded the public fail-closed regression, and [G44 job
101940978323](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978323)
recorded the unchanged 5,000 ms G67 timeout. AC4/AC5 remain open.

## Verification

Passing focused checks at the W169 source:

- `npx vitest run test/g69-ordering.spec.ts --pool=forks --maxWorkers=1
  --no-file-parallelism --disableConsoleIntercept`: 1 file, 7 tests passed.
  This covers the real
  allocator-to-Tag-to-D1 witness, mixed unknown/proven detector scanning,
  decreasing-timestamp MIN replay, generation/public-read clocks, typed
  quarantine during `waitFor`, complete real rebuild recovery (including
  valid empty output), stale/incomplete proof rejection, and diagnostic
  failure/concurrency/replay/retention.
- `npx vitest run test/g31-waitfor.spec.ts test/g55-read-visibility.spec.ts
  --pool=forks --maxWorkers=1 --no-file-parallelism`: 2 files, 30 tests
  passed, including timeout-quarantine and generation-change boundary reads.
- `npx vitest run --config vitest.config.ts test/d1-mv.spec.ts`: 14/14
  passed with the existing default configuration; no detector opt-in was added
  to the regression.
- `npm run test:g69`: green; five accepted mutants are red: omitted
  unconditional batch-order guard, omitted late-lower detector, restored
  higher-SUID lag exclusion, omitted append-only receipt, and awaited
  diagnostic receipt on the core path.
- `npm run test:g46`: green; 4 files/31 tests passed and all nine G46
  production mutation probes were red. `test/read.spec.ts` is unchanged and
  retains its expected public HTTP 500 high-lag assertion.
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

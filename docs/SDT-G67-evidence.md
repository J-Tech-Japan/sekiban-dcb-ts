# SDT-G67 evidence — final amended AC4/AC5 disposition

This document retains the local AC1–AC3 proof and the W145/W146 deployed
receipts for issue #129. The final amended AC4/AC5 ownership is the
fence-expiry scheduling result: production scheduling-wait p95 is at or below
5,000 ms and all ten production samples became safe within 180,000 ms. Safe
first visibility is measured and attributed, not a target. Pass latency,
fence wait, ring arrival, Queue arrival, and strict unsafe misses are reported
as attribution facts and are not G67 gates. No cohort was rerun for this
amendment.

## Final amended AC4/AC5 reconciliation — W145/W146

The retained W145 arm receipts were sufficient to derive the required
attribution columns, so neither the arm nor production cohort was repeated.
W145 recorded 56 fence stops, 9 completed fence-expiry passes, and
`SafeWindow=20000 ms`. Its candidate residual scheduling-wait p95 was 936 ms;
its pass-latency p95 was 27598 ms. Those rows remain intact as arm evidence.

W146 production used the existing sample Worker
`sekiban-dcb-meeting-room-cloudflare-only` after the C-0 reset and the exact
candidate source `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae`. The final deployed
version was `11c907ff-dde3-44c3-928e-550303d47aac` at 100% with the exact-source
annotation recorded in the W146 receipts. The deployed production
configuration was `DIRECT_DOORBELL=false`, receiver mode `"separate"`,
and no `DOWNSTREAM_DOORBELL` service binding. Consequently the production
ring-arrival population is zero and direct-ring/unsafe rows are non-gated in
G67; the strict unsafe observation misses remain recorded honestly.

The production run was cold-first and paced at ten seconds, with `n=10`, run
ID `7b5cdd0f-ed47-46a2-8f7c-b2d04e9aff20`. The owned gates passed:
scheduling-wait p95 `1608 ms <= 5000 ms`, and safe first visibility `10/10 <
180000 ms`. All ten strict 5000 ms unsafe observations missed, while all ten
eventually became visible. The production pass-latency p95 was `16983 ms`;
this is broader than the arm catch-up cost because it includes production
Queue-arrival, fence, and deferred-pass timing rather than only catch-up
execution. It is reported attribution, not an amended G67 gate.

`Queue arrival` below is the maximum, across the room and reservation
obligations for the exact sample, of `consumer-invocation-started -
queue-send-returned`. `Fence wait` is `stop_deadline_at - command-receipt` for
the selected completed pass row. `Scheduling wait` is
`started_at - scheduled_at`; `pass` is `completed_at - started_at`. The
selected row is the last completed row for the exact delivery SUID, preferring
a completed fence-expiry row. Ring arrival is `—` for every sample because
the deployed direct ring is disabled. The raw batch-level ledger remains the
authoritative record.

| # | exact SUID | response | unsafe eventual | safe | ring arrival | Queue arrival | fence wait | scheduling wait | pass | trigger | stop reason |
|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---|---|
| 1 | `063924305177989000001699136368` | 1944 | 115342 | 116916 | — | 9028 | 41655 | 203 | 9939 | fence-expiry | safe_window_fence |
| 2 | `063924305189942000001445738364` | 1929 | 103481 | 104975 | — | 10548 | 54995 | 219 | 11713 | fence-expiry | safe_window_fence |
| 3 | `063924305202088000000186107726` | 2172 | 91401 | 92801 | — | 15044 | 60760 | 230 | 13617 | fence-expiry | safe_window_fence |
| 4 | `063924305214231000001842017430` | 2000 | 79493 | 80735 | — | 16868 | 48694 | 270 | 4982 | delivery | safe_window_fence |
| 5 | `063924305226385000001467339264` | 2092 | 67331 | 76684 | — | 22375 | 60230 | 257 | 15760 | fence-expiry | safe_window_fence |
| 6 | `063924305238640000001842031745` | 2388 | 55070 | 66724 | — | 15452 | 59003 | 216 | 15086 | fence-expiry | safe_window_fence |
| 7 | `063924305251043000001307772868` | 2059 | 42968 | 59204 | — | 11860 | 57528 | 213 | 16983 | fence-expiry | safe_window_fence |
| 8 | `063924305263164000001063677243` | 2152 | 30920 | 80210 | — | 22514 | 62698 | 1608 | 3312 | delivery | safe_window_fence |
| 9 | `063924305275242000000197541936` | 2022 | 19008 | 68186 | — | 12205 | 33351 | 119 | 4825 | delivery | safe_window_fence |
| 10 | `063924305287381000001223743116` | 2284 | 9535 | 55900 | — | 6998 | 38388 | 1032 | 5365 | delivery | safe_window_fence |

All values are milliseconds from observed clocks. Production distributions:

| measure | n | p50 | p95 | disposition |
|---|---:|---:|---:|---|
| command response | 10 | 2059 | 2388 | measured |
| Queue arrival | 10 | 12205 | 22514 | reported attribution |
| fence wait | 10 | 54995 | 62698 | reported attribution |
| scheduling wait | 10 | 219 | 1608 | **owned gate passed** |
| pass latency | 10 | 9939 | 16983 | reported attribution, not a gate |
| safe first visibility | 10 | 76684 | 116916 | measured; 10/10 under 180 s |
| unsafe eventual visibility | 10 | 55070 | 115342 | strict 5 s observation missed 10/10 |

The production durable receipts contain 126 seven-hop rows, 252 post-admission
rows, and 320 safe-pass rows. The final safe-pass receipt records delivery,
fence-expiry, and cron triggers, with 55 `safe_window_fence` stops and 8
`advanced_or_caught_up` completions. The safe history ends SETTLED at
`063924305287381000001223743116`. Raw W145 and W146 receipts remain under
`.artifacts/` with the task-specific prefixes.

### Authorized W147 cleanup

After read-only target resolution, W147 found W131-C outbox with one consumer
and its DLQ with zero consumers. It removed only the W131-C outbox consumer,
then deleted Worker `sekiban-dcb-g60-w131-c`, pipeline D1
`b03270df-9698-4a9e-94c6-c2c5726f106d`, MV D1
`616dd377-42f3-49f7-b373-a1a07cedf2b3`, outbox Queue, and DLQ in the required
order. Final inventories show those W131-C resources absent while W155-C and
the production D1/Queue resources remain. No production, W155-C, G32, G26, or
doorbell resource was touched.

## W149 request-update repair — exact-head local evidence

W149 repairs the four exact-head findings from review 5126081331 without a
deployment or Cloudflare operation. The repair is based on the existing branch
head `61c95675e05d82091a126e944063d77e9eda0af7` and preserves all retained
W145/W146 receipts; it does not recalculate an acceptance result from them.

### F1 — applying-pass attribution

The old W146 selection rule (`started_at - scheduled_at`) and delivery-owner
join did not prove that the selected pass applied the sampled event. For
example, the selected row for sample 8 did not apply its SUID, and the selected
fence-expiry row for sample 7 applied zero events while an overlapping delivery
pass applied. The source now records event-level MV apply observations in each
catch-up result: exact `suid`, observed `lastArrivedAt`, derived
`fenceEligibleAt = lastArrivedAt + safeWindowMs`, and observed `appliedAt`.
The later deployed cohort must join each sample to the pass containing its
exact applied-event detail; no W149 document value treats a non-applying row as
the sample's scheduling attribution. The old W146 16,983 ms pass value remains
historical attribution only: its selected pass left 11,866 ms unexplained by
catch-up execution, so W149 does not claim that it identifies the scheduling
wait.

### F2 — cron uses the shared scheduler

`beforeLiveProjectionPoll` now receives the scheduled handler's
`ExecutionContext` and enters `scheduleMeetingRoomSafeLaneKick` with
`trigger="cron"`. Delivery and cron therefore share the same per-service
single-flight/coalescing scheduler; the cron hook no longer calls the pass body
directly. The focused oracle holds one pass open, submits delivery and cron
triggers concurrently, and proves maximum active passes is one with one
coalesced second pass. The `cron-bypasses-single-flight-scheduler` mutation is
retained and red.

### F3 — genuine local public-path proof

The AC3 oracle now uses the actual serialized public commit endpoint through
the test Worker, real Tag Durable Objects and Tag outbox rows, the real
`handleDownstreamQueue`/`recordDelivery` path, the shared safe-lane scheduler,
and the public safe list reader. It runs ten distinct commits with cron
disabled and records each returned event SUID, observed commit/delivery/safe
clocks, and public safe head. The local test uses a deterministic logical clock
to avoid ten 20-second SafeWindow sleeps; it is a local causal/path proof, not
a deployed latency result. The omitted-kick mutation remains red, so this
proof cannot pass through the old synthetic callback/head injection.

### F4 — deployed receiver documentation

The exact W146 production version view is documented as
`DIRECT_DOORBELL=false`, `DIRECT_DOORBELL_RECEIVER_MODE="separate"`, and no
`DOWNSTREAM_DOORBELL` service binding. This is the deployed configuration
fact; the old “absent/unconfigured” wording was incorrect and is superseded.
No W149 deployment, cohort, resource operation, or acceptance-criteria change
was performed. A later deployed cohort is required to produce corrected F1
scheduling attribution.

## Source and process

- Base: `origin/main` at `868f2fc` after `git fetch origin`.
- Branch: `claude/sdt-g67-local-wake-w142`.
- Host execution-unit claim: supplied evidence says owned by
  `codex-net-orchestration / sekiban-dcb-ts-orch`, host commit
  `4e3a34fd2aa6b140d3ae431793e3c30b44d27dfb`.
- Child claim command was attempted before editing:
  `intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind issue --number 129 --github-only --write --format json`.
  It made no change because the issue already carried `intent-issue-in-progress`;
  the exact result was `proceed=false`, `applied=false`, error
  `claim.stale.already-in-progress: issue already carries 'intent-issue-in-progress'.`
  No raw label operation was used.
- The standalone issue URL was unavailable through the web cache in this
  environment; the checked-in SDT-G67 packet was used as the local contract.

## W149 implementation

`handleDownstreamQueue` now exposes a Queue-only stored-delivery hook. It is
called after a stored `recordDelivery` result has selected its Queue ack/retry
disposition, including a G44 completeness failure, and is not called after a
record-delivery failure. The sample callback only calls `waitUntil`.

`createSafeLaneKickScheduler` provides per-service single flight plus one
coalesced rerun. The kick first runs a fresh
`GlobalCompletenessReconciler.reconcile`, then uses
`runMeetingRoomScheduledMaintenance`, so coverage, retained-frontier fencing,
unsafe-kick draining, and both materialized-view catch-up paths remain shared
with cron. Cron now enters this same scheduler with its `ExecutionContext` and
remains the backstop. The Queue hook remains notification-only and starts the
non-blocking scheduler under `waitUntil`.

`catchUpMeetingRoomMaterializedViews` now attaches an event-level
`afterApply` observation to the existing MV catch-up hooks. This is additive
evidence only: it records the event actually applied by the view and observed
fence eligibility/apply clocks without changing coverage, frontier, safe-head,
ordering, or Queue disposition semantics.

## W149 red/green evidence

The required guard is `scripts/g67-safe-lane-guard.mjs`. It preserves the
following receipts:

- `test/fixtures/g67-red-before-green.json`: the seven-mutant pre-green guard
  run is retained; the normal oracle was not accepted until the omitted-kick,
  cron-bypass, coalesced-owner, BLOCK/frontier, awaited-hook, omitted-catch-up,
  and omitted-fence-expiry mutations were red.
- `test/fixtures/g67-green.json`: the focused W149 AC1–AC4 oracles passed.
- `test/fixtures/g67-mutants-red.json`: all seven W149 mutations remained red
  after the implementation.

The AC1 focused file also contains a concurrent-kick oracle: three deliveries
share one service scheduler, the first pass is held open, and the coalesced
rerun observes the same final head. The observed maximum active pass count is
`1`, the pass count is `2` (initial pass plus one coalesced rerun), and both
recorded heads are identical.

The package lane is:

```text
npm run test:g67
```

It runs the focused Vitest file, unique-anchor self-test, red-before-green
receipt, green tests, and both mutation receipts. The local CI workflow now
invokes this lane in the existing G44 lane and retains the forced-red
reachability probe; existing gates were not removed, weakened, or
timeout-inflated.

## W149 AC3 local proof

`test/g67-safe-lane.spec.ts` drives ten distinct serialized public commits with
cron disabled. Each commit is accepted by the real test Worker, creates real
Tag outbox rows, is delivered through the real Queue adapter/`recordDelivery`
path, and enters the actual safe-lane scheduler. The test then reads the
public safe list and asserts the affected reservation is present with a safe
head for every commit. It records the returned event SUID and observed
commit, delivery, and safe clocks. The logical clock advances by 60,000 ms
between commits so the test is deterministic and does not sleep through the
SafeWindow; that clock substitution is explicitly not a deployed latency
claim. The exact observations are emitted as `G67_AC3_OBSERVATIONS` by the
focused test and the seven-mutation receipt preserves the red proof.

The old synthetic `committedHead`/callback-only proof is no longer the AC3
oracle. The existing G44/G62 frontier and public safe-reader semantics are
unchanged. A later deployed cohort remains necessary for production timing and
for F1's applying-pass scheduling attribution.

## Historical W142 AC3 local proof

The following compact table is retained only as the superseded W142 local
checkpoint and is not the W149 AC3 proof:

| commit | logical delivery time | logical safe time | delivery→safe | safe head |
|---:|---:|---:|---:|---|
| 1 | 10,000 | 10,025 | 25 ms | `062135596800000000123997487868` |
| 2 | 20,000 | 20,025 | 25 ms | `062135596800000000222532372501` |
| 3 | 30,000 | 30,025 | 25 ms | `062135596800000000323020744290` |
| 4 | 40,000 | 40,025 | 25 ms | `062135596800000000425462603235` |
| 5 | 50,000 | 50,025 | 25 ms | `062135596800000000525950975024` |
| 6 | 60,000 | 60,025 | 25 ms | `062135596800000000624485859657` |
| 7 | 70,000 | 70,025 | 25 ms | `062135596800000000724974231446` |
| 8 | 80,000 | 80,025 | 25 ms | `062135596800000000819602141767` |
| 9 | 90,000 | 90,025 | 25 ms | `062135596800000000920090513556` |
| 10 | 100,000 | 100,025 | 25 ms | `062135596800000001014284255396` |

These are deterministic local logical-clock observations, not deployed
latencies. The paired AC1 tests prove a stored Queue result still invokes the
kick hook when the G44 path returns `BLOCK` and that concurrent kicks remain
single-flight; the AC2 test proves the kick pass uses only the retained proven
frontier. The G44/G62/G61/G60/G65 existing lanes remain separate and
unchanged.

## W149 local gates

The focused repair and directly affected protections passed locally:

- `npm run test:g67` — 11 tests; the genuine public-path AC3 proof passed;
  red-before-green and all seven mutation rows were red, including the new
  cron-bypass mutation. `npm run test:g67:forced-red` also completed its
  normal lane and retained the same red receipts.
- `npm run test:g31`, `npm run test:g44`, `npm run test:g58`,
  `npm run test:g60:required`, `npm run test:g61`, `npm run test:g62`, and
  `npm run test:g65:required` — passed. The G58 source-anchor updates only
  follow the new `ctx` parameter and do not alter G58 behavior.
- `npm run test:g21`, `npm run test:g22`, `npm run test:g23`,
  `npm run test:g24`, `npm run test:g25`, `npm run test:g26`,
  `npm run test:g27`, `npm run test:g38:prep`, `npm run test:g41`,
  `npm run test:g42`, `npm run test:g43`, `npm run test:g45`,
  `npm run test:g46`, `npm run test:g49`, `npm run test:g51`,
  `npm run test:g53`, `npm run test:g54`, `npm run test:g55`, and
  `npm run test:g56` — passed with their existing mutation/forced-red
  protections.
- `npm run test:g29:mapping`, `npm run test:g29:delivery`,
  `npm run test:g29:diagnostics`, `npm run test:g29:compatibility`,
  `npm run test:g29:domain-source`, `npm run test:g29:authoring-doc`,
  `npm run test:g29:sample`, `npm run test:g29:witness`, and
  `npm run test:g29:candidate` — passed. The candidate protocol reported its
  retained historical candidate was not an ancestor, as expected for this
  branch; no deployment was attempted.
- `npm run test:g28`, `npm run test:g28:compile-fail`,
  `npm run test:g28:boundary:source`, `npm run test:g28:boundary:negative`,
  `NPM_CONFIG_CACHE=/private/tmp/sdt-g67-w149-npm-cache npm run test:g28:boundaries`,
  and the same cache-qualified package-manifest gate — passed. The two
  default-cache boundary attempts failed only because npm could not write
  `/Users/tomohisa/.npm/_logs`; the cache-qualified retries passed.
- `npm run test:g20`, `npm run test:g20:gate`, `npm run test:g20:candidate`,
  `npm run test:g16`, `npm run test:g17`, `npm run test:g17:rollout-order`,
  `npm run test:store-contract`, `npm run test:d1`, `npm run test:mv`,
  `npm run test:boundaries`, `npm run test:consumer`, `npm run test:g37:evidence`,
  `npm run typecheck`, and `npm run lint` — passed.

The exact aggregate `npm test` was also run. It exited non-zero with 4
5-second test timeouts among 778 tests (773 passed, 1 skipped): the existing
`test/commit.spec.ts` AC7, existing `test/tag.spec.ts` G5,
`test/repair.spec.ts` checkpoint, and the new G67 AC3 test when running in the
full parallel pool. The G67 file passes in its isolated focused lane; this is
recorded as a local parallel-runner contention/timeout exception, not called a
green aggregate and not repaired by changing a timeout. The exact G30 workflow
lane then produced its schema/B0/manifest and mutation receipts but emitted no
new output for about 90 seconds; it was terminated with Ctrl-C, exit 130. The
exact G32 workflow lane passed its 10-file/50-test Vitest portion and initial
mutation output, then produced no output for about 90 seconds and was likewise
terminated with Ctrl-C, exit 130. These are runner exceptions; no gate,
assertion, schedule, or timeout was weakened.

The workflow steps that would invoke `wrangler deploy` (`npm run build`) or a
Wrangler local E2E were intentionally not run because W149 forbids deployment
and Cloudflare operations. No Wrangler or Cloudflare command was invoked.
`git diff --check` is clean for the scoped W149 checkpoint; unrelated dirty and
untracked historical evidence remains unstaged.

## Historical W142 local gates

The earlier W142 aggregate notes below are retained for provenance only. They
are not substituted for the W149 focused and affected-lane results above.

## Former local boundary (historical W142 checkpoint)

The original deploy-free checkpoint intentionally stopped before AC4/AC5 and
did not deploy to the reused `sekiban-dcb-g60-w155-c` arm or use the
production sample. W145/W146 later supplied the retained arm and production
receipts reconciled in the final amended section above; no cohort was rerun for
the amendment.

## W142 deployed arm measurement (blocked before production)

This section records the single W142 arm window. It is historical measurement
evidence, not the final amended AC4/AC5 disposition. The original arm gate
failed, so the production sample was not reset or deployed in W142.

### Source identities and deployment correction

- Full-range pre-change parent: `868f2fc63bb02fb2c127e750c1d22516cc0fcff6`.
  `git merge-base 8e8f13d9cb14d547193dc642d9038e5b80d7444a origin/main`
  returned this SHA.
- G67 feature commit: `f5b2212ad90cdf5c760ff4f43b8a3ef8f7a8954f`.
  This is the immediate parent of the evidence-only candidate checkpoint and
  is not the pre-change baseline.
- Candidate: `8e8f13d9cb14d547193dc642d9038e5b80d7444a`.
- An initial parent deployment of `f5b2212` was discarded before reset or
  cohort measurement. Its receipt is retained in
  `.artifacts/sdt-g67-w142-parent-deploy.log`; version
  `2ac59226-1c50-425e-9a7f-122c2cc330fa` and deployment
  `aea63906-cd3c-488c-9e18-3743147eb7dd` are identity-only receipts and are
  not baseline evidence.

The valid parent deployment was version
`5961d52f-4627-4498-978a-687ad13b3f5f`, deployment
`3b114dd3-65b9-41d8-a271-c4641296a61f`, with annotation
`SDT-G67 W142 true parent exact 868f2fc63bb02fb2c127e750c1d22516cc0fcff6 W155-C normal arm`.
The candidate deployment was version
`9d2f26f2-77f1-403a-a90e-7b0808b72640`, deployment
`643ef61d-3955-421b-883b-305330f35568`, with annotation
`SDT-G67 W142 candidate exact 8e8f13d9cb14d547193dc642d9038e5b80d7444a W155-C normal arm`.
Both version views were 100% active and showed `DIRECT_DOORBELL=true`,
self receiver mode/proof, `DOWNSTREAM_DOORBELL` service
`sekiban-dcb-g60-w155-c`/entrypoint `MeetingRoomDownstreamDoorbell`, the
existing pipeline D1 `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, Queue
`sekiban-dcb-g60-w155-c-outbox`, and DLQ
`sekiban-dcb-g60-w155-c-outbox-dlq`.

All five Wrangler credential variable names were unset for the remote
operations. The conformance credential was supplied only by the existing path
`/private/tmp/sdt-g65-wake141-token.pdPTFB/conformance-token`; its value is not
present in this document or the receipts. No resource was created or deleted.

### Reset and cohort protocol

The W155-C pipeline and MV operational rows were reset before each cohort with
the existing schema and queues. The corrected scalar count receipts show:

| arm | pipeline operational counts | MV operational counts |
|---|---|---|
| parent | `dcb_events=0`, `source_partitions=0`, `global_receipts=0`, `admission_attempts=0`, `direct_rings=0`, `hop_measurements=0`, `hop_submeasurements=0`, `unsafe_writer_boundaries=0`, `safe_lane_history=0` | `mv_rows=0`, `mv_unsafe_receipts=0`, `mv_unsafe_rows=0`, `mv_unsafe_kicks=0`, `mv_instances=2`, `mv_active_generations=2` |
| candidate | `dcb_events=0`, `source_partitions=0`, `global_receipts=0`, `admission_attempts=0`, `direct_rings=0`, `hop_measurements=0`, `hop_submeasurements=0`, `unsafe_writer_boundaries=0`, `safe_lane_history=0` | `mv_rows=0`, `mv_unsafe_receipts=0`, `mv_unsafe_rows=0`, `mv_unsafe_kicks=0`, `mv_instances=2`, `mv_active_generations=2` |

Both cohorts used the same cold-first command and pacing:

```text
G53_CONFORMANCE_TOKEN_FILE=/private/tmp/sdt-g65-wake141-token.pdPTFB/conformance-token \
node scripts/deploy/g58-safe-lane-e2e.mjs \
  --base-url https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev \
  --service-id sekiban-dcb-g60-w155-c --mode paced --paced-count 10 \
  --pace-ms 10000 --poll-ms 2000 --continue-after-unsafe --report <raw-report>
```

The parent run ID was `7de42032-6a7e-4e87-8db9-054c141b6cfa`; the candidate
run ID was `3147d381-f03e-4596-8a01-874b14544f43`. Every sample was accepted,
and every raw report was flushed by the harness.

### Arm result

| arm | response p50/p95 | unsafe p50/p95 | unsafe >5,000 ms | safe p50/p95 | safe <180,000 ms |
|---|---:|---:|---:|---:|---:|
| parent `868f2fc` | 2,606 / 2,866 ms | 2,806 / 2,949 ms | 0/10 | 79,085 / 117,404 ms | 10/10 |
| candidate `8e8f13d` | 2,585 / 3,072 ms | 2,783 / 2,944 ms | 0/10 | 67,269 / 117,661 ms | 10/10 |

The candidate response p95 increased by **206 ms** (3,072 − 2,866), exceeding
the same-window +150 ms limit. The candidate safe p95 was **117,661 ms**, also
above the candidate-arm 60,000 ms target, although all ten samples became safe
within 180,000 ms. Unsafe p95 improved by 5 ms and all ten unsafe reads were
within the unchanged 5,000 ms contract. The arm therefore fails the response
and safe-p95 gates; no production cohort was authorized or run.

Queue sub-hop distributions were parent p50/p95 `1,243/2,737 ms` from Queue
send return to consumer invocation and `994/1,304 ms` from invocation to
record-delivery commit. Candidate values were `1,627/10,579 ms` and
`808/1,276 ms`, respectively. Direct apply durations were parent
`1,659/1,860 ms` and candidate `1,661/2,118 ms` (p50/p95). These are observed
durable timestamps, not authored event timestamps.

### Complete per-commit observed table

The epoch-millisecond columns are the persisted/observer clocks: `commit` is
the public response receipt time, `qSend`, `qStart`, and `qCommit` are the
Queue hop boundaries, and `unsafeRead` is the durable first-unsafe-read
boundary. `safeMs` and `safeAt` are the harness's observed public safe result.
`ring/apply` is the direct ring/apply ledger; all current rows were `rung` and
`applied`. `qΔ` is Queue send→consumer start and `dΔ` is consumer start→batch
commit. The `trigger` column is intentionally explicit about the available
provenance; see the trigger ledger below.

#### Parent `868f2fc63bb02fb2c127e750c1d22516cc0fcff6`

|#|event ID|SUID|commit|response|unsafe ms|safe ms|qSend|qStart|qΔ|qCommit|dΔ|unsafeRead|ring/apply|apply ms|trigger|
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
|1|`01a0764c-d124-7041-948d-7dae317028ff`|`063924287941855000000927750081`|1788691142799|2549|2628|117404|1788691142636|1788691144619|1983|1788691145311|692|1788691145408|rung/applied|1470|cron/backstop|
|2|`01a0764d-047a-7146-8985-8a688358d53e`|`063924287954830000000075032896`|1788691155781|2606|2778|104422|1788691155654|1788691158391|2737|1788691159178|787|1788691158538|rung/applied|1557|cron/backstop|
|3|`01a0764d-36be-7954-85a7-fb05cdbc09fe`|`063924287967580000000413364058`|1788691168583|2801|2916|91620|1788691168357|1788691169600|1243|1788691170476|876|1788691171476|rung/applied|1803|cron/backstop|
|4|`01a0764d-67a3-73ea-836d-a7b36590be49`|`063924287980086000001773427440`|1788691181118|2533|2618|79085|1788691180909|1788691182087|1178|1788691183095|1008|1788691183716|rung/applied|1499|cron/backstop|
|5|`01a0764d-98b5-7b59-981a-97850e6f618b`|`063924287992788000000542336472`|1788691193893|2772|2949|100169|1788691193616|1788691194801|1185|1788691195675|874|1788691196816|rung/applied|1659|cron/backstop|
|6|`01a0764d-c9de-7f5d-a165-6d82b37ee09e`|`063924288005234000000976524346`|1788691206251|2356|2895|87811|1788691206035|1788691207214|1179|1788691208208|994|1788691209119|rung/applied|1792|cron/backstop|
|7|`01a0764d-fa97-75c9-8cb6-f516070db2e1`|`063924288017817000001294343380`|1788691218913|2662|2806|75149|1788691218650|1788691220028|1378|1788691221266|1238|1788691221693|rung/applied|1675|cron/backstop|
|8|`01a0764e-2b89-7d73-8639-83aef6a97a80`|`063924288030247000000340676187`|1788691231166|2250|2824|62896|1788691231031|1788691232188|1157|1788691233312|1124|1788691233964|rung/applied|1860|cron/backstop|
|9|`01a0764e-5c23-7da8-9901-1e93733f5c32`|`063924288042838000000545675244`|1788691243940|2773|2762|52500|1788691243677|1788691245145|1468|1788691246449|1304|1788691246677|rung/applied|1855|cron/backstop|
|10|`01a0764e-8e14-74f9-aed8-de8724f152da`|`063924288055742000001471119526`|1788691256807|2866|2844|39633|1788691256571|1788691258287|1716|1788691259302|1015|1788691259623|rung/applied|1420|cron/backstop|

#### Candidate `8e8f13d9cb14d547193dc642d9038e5b80d7444a`

|#|event ID|SUID|commit|response|unsafe ms|safe ms|qSend|qStart|qΔ|qCommit|dΔ|unsafeRead|ring/apply|apply ms|trigger|
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
|1|`01a07655-aec4-7aed-ac76-d75a3a9a267c`|`063924288522584000000921680792`|1788691723501|2325|2783|117661|1788691723419|1788691727549|4130|1788691728086|537|1788691726264|rung/applied|1336|kick requested; winner not persisted|
|2|`01a07655-deed-75b9-9cd8-9a6a6fbbf7a5`|`063924288535006000001623617049`|1788691736027|2524|2653|105135|1788691735847|1788691743070|7223|1788691743786|716|1788691738660|rung/applied|1568|kick requested; winner not persisted|
|3|`01a07656-0f14-7c0e-98a0-f9b347576ba1`|`063924288547223000000357223741`|1788691748167|2138|2740|92995|1788691747963|1788691753810|5847|1788691754391|581|1788691750887|rung/applied|1678|kick requested; winner not persisted|
|4|`01a07656-3f86-7e66-8dd0-f8a61f803ad6`|`063924288559819000000904001847`|1788691760853|2683|2690|80309|1788691760733|1788691771312|10579|1788691772588|1276|1788691763521|rung/applied|1801|kick requested; winner not persisted|
|5|`01a07656-72b9-7fe0-a44a-31c5428a448c`|`063924288572885000001934473981`|1788691773893|2596|2785|67269|1788691773668|1788691783516|9848|1788691784047|531|1788691776657|rung/applied|1661|kick requested; winner not persisted|
|6|`01a07656-a5cc-7a15-af37-1cc25f625315`|`063924288586207000001475827699`|1788691787385|3072|2944|53777|1788691787096|1788691788719|1623|1788691789602|883|1788691790311|rung/applied|1894|kick requested; winner not persisted|
|7|`01a07656-d89b-7ba0-ae9c-c11e2acfce70`|`063924288598964000001977391542`|1788691799972|2585|2802|41190|1788691799826|1788691801453|1627|1788691802261|808|1788691802753|rung/applied|1524|kick requested; winner not persisted|
|8|`01a07657-0a28-7ba2-b39f-b856caee8b58`|`063924288611652000001522689977`|1788691812763|2789|2776|35548|1788691812456|1788691813671|1215|1788691814620|949|1788691815517|rung/applied|1578|kick requested; winner not persisted|
|9|`01a07657-3b86-7882-87e2-3d7e74c338f8`|`063924288624216000000176915988`|1788691825142|2378|2796|68194|1788691825044|1788691826414|1370|1788691827261|847|1788691827913|rung/applied|1886|kick requested; winner not persisted|
|10|`01a07657-6c4f-7b72-9945-d2031672bbb5`|`063924288636725000000799505470`|1788691837763|2619|2913|55573|1788691837563|1788691838757|1194|1788691839815|1058|1788691840656|rung/applied|2118|kick requested; winner not persisted|

The complete raw row receipts under `.artifacts/sdt-g67-w142-arm-{parent,candidate}-*.json`
contain the original seven-hop ledger, admission/ring rows, sub-hops,
unsafe-writer boundaries, MV rows/receipts, health snapshots, and cohort
records. For the current ten reservation IDs in each arm: all direct ring
rows are `rung`; all direct apply rows are `applied`; the Queue replay ends in
`duplicate-race`; `mv_unsafe_receipts` has 11 rows (room plus ten
reservations), `mv_unsafe_rows` has 0 rows, and `mv_rows` has 11 rows. This is
the observed idempotence/no-regression result, not a claim that the arm passed
the latency gates.

### Safe-pass trigger and history provenance

The candidate source schedules the non-blocking event-driven kick after a
stored Queue delivery; the parent source predates that G67 hook and therefore
uses the scheduled cron backstop. However, the deployed health surface and
`serialized_dcb_safe_lane_history` persist only scheduled coverage history,
with `tick_id=scheduled:<epoch>`; they do not persist a per-pass `kick` or
`cron` trigger field. Therefore the per-commit trigger is recorded precisely
as “kick requested; winner not persisted” for the candidate and
“cron/backstop” for the parent, rather than inferred from a safe head.

The persisted tick ledger was:

| arm | tick ID | kind | reason | partition tag | proven frontier |
|---|---|---|---|---|---|
| parent | `scheduled:1788690985871` | SETTLED | — | — | empty |
| parent | `scheduled:1788691045243` | SETTLED | — | — | empty |
| parent | `scheduled:1788691105140` | SETTLED | — | — | empty |
| parent | `scheduled:1788691165018` | SETTLED | — | — | `063924287954830000000075032896` |
| parent | `scheduled:1788691226673` | SETTLED | — | — | `063924288017817000001294343380` |
| parent | `scheduled:1788691285516` | SETTLED | — | — | `063924288055742000001471119526` |
| candidate | `scheduled:1788691705134` | SETTLED | — | — | empty |
| candidate | `scheduled:1788691765671` | SETTLED | — | — | `063924288559819000000904001847` |
| candidate | `scheduled:1788691827137` | SETTLED | — | — | `063924288624216000000176915988` |
| candidate | `scheduled:1788691886426` | SETTLED | — | — | `063924288636725000000799505470` |

The final public health snapshots reported both RoomProjector and
ReservationProjector safe heads at the final cohort SUID in each arm. The
history rows above are the persisted cron observations; the raw cohort files
retain every intermediate health snapshot and per-projector safe head.

### W142 disposition and retained raw receipts

W142 was **BLOCKED** at the isolated-arm gate. The exact candidate response
p95 miss (+206 ms versus the parent, over the +150 ms allowance) and safe p95
miss (117,661 ms versus 60,000 ms) prevented production work in that
continuation. W146 later performed the separately authorized production proof
under the amended ownership. No code or configuration change was made in
W142. The earlier f5b2212
deployment is retained only as a discarded identity receipt and is never used
to calculate a baseline.

Relevant receipts include the parent/candidate deploy/version/deployment
records, reset SQL and reset/count results, cohort JSON/log files, all direct
ledger table reads, and the corrected MV-D1 reads. Three initial post-run
read-only queries accidentally addressed MV table names to the pipeline D1 and
returned local SQLite code 7500 `no such table`; they changed no state. The
same reads against the stated MV D1 then succeeded and are retained with
`-mv` filenames. This was not an authorization failure and did not trigger a
write retry or alternate resource path.

## W142 AC4 local repair checkpoint

The W142 arm miss is retained as measurement evidence: candidate safe p95 was
117,661 ms (above the 60,000 ms target) and candidate response p95 was 3,072
ms versus the true parent baseline 2,866 ms (+206 ms, above the +150 ms
allowance). The candidate had no unsafe >5,000 ms rows and all ten samples
became safe within 180,000 ms, but the arm was correctly blocked. The discarded
`f5b2212` deployment remains identity-only and is not a baseline.

### Cause and bounded repair

The pre-repair implementation did have a Queue callback, but it exposed no
durable pass lifecycle. `serialized_dcb_safe_lane_history` was written only by
the cron `recordCoverage` callback, so the W142 health snapshots could say
“kick requested; winner not persisted” but could not distinguish a kick that
was scheduled, started, coalesced, failed, or completed. The source therefore
cannot support the stronger claim that cron caused the measured safe p95; the
trigger provenance was incomplete. The current code path also invoked an
awaitable callback and started the scheduler before registering its promise,
which left an avoidable asynchronous boundary in the delivery path.

The local repair keeps the existing G44/G62 pass body and frontier argument
unchanged, but makes the Queue notification synchronous and non-awaiting,
defers observer/scheduler start behind `waitUntil`, and admits every successful
stored/idempotent Queue `recordDelivery` result unless the durable
`recordDelivery` phase itself failed. The additive
`serialized_dcb_safe_lane_passes` ledger records `kick`/`cron`, scheduled,
running, completed, failed, and coalesced lifecycle states, observed times,
coverage kind/reason/partition/frontier, and safe-head snapshots before/after.
Observer failure is best effort and cannot change Queue disposition, G44
certification, or safe catch-up. Cron remains the backstop.

Local red-capable coverage now proves Queue hook non-awaiting, lifecycle
provenance, one-isolate single-flight/coalesced rerun, and retained-frontier
behavior under `BLOCK/UNSETTLED`; the existing omitted-kick and frontier
mutants remain red. The three local G67 mutations are omitted kick,
advance-under-BLOCK, and awaited Queue hook. No deployment, reset, Wrangler,
Cloudflare, production, PR, or acceptance-bound change is part of this
checkpoint.

# SDT-G67 local checkpoint

This document is the deploy-free AC1–AC3/local-AC6 checkpoint for issue #129.
It does not claim the same-arm AC4 or production AC5 deployment proof; those
remain for the separately delegated continuation. No Wrangler, Cloudflare,
reset, deployment, resource, or PR operation was used here.

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

## Implementation

`handleDownstreamQueue` now exposes a Queue-only stored-delivery hook. It is
called after a stored `recordDelivery` result has selected its Queue ack/retry
disposition, including a G44 completeness failure, and is not called after a
record-delivery failure. The sample callback only calls `waitUntil`.

`createSafeLaneKickScheduler` provides per-service single flight plus one
coalesced rerun. The kick first runs a fresh
`GlobalCompletenessReconciler.reconcile`, then uses
`runMeetingRoomScheduledMaintenance`, so coverage, retained-frontier fencing,
unsafe-kick draining, and both materialized-view catch-up paths remain shared
with cron. The cron hook remains the backstop and records its existing health
history; kicks emit an observation-only `safe_lane_pass` log with
`trigger=kick`.

## Red/green evidence

The required guard is `scripts/g67-safe-lane-guard.mjs`. It preserves the
following receipts:

- `test/fixtures/g67-red-before-green.json`: both the omitted-kick mutant and
  the frontier-omission mutant were red before the normal oracle was accepted.
- `test/fixtures/g67-green.json`: AC1–AC3 focused tests passed.
- `test/fixtures/g67-mutants-red.json`: both mutants remained red after the
  implementation.

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
invokes this lane in the existing G44 lane and adds a forced-red reachability
probe; existing gates were not removed, weakened, or timeout-inflated.

## AC3 local proof

`test/g67-safe-lane.spec.ts` drives ten logical commits at 10,000 ms spacing
with cron disabled. Each commit schedules the actual exported kick scheduler;
the injected pass calls the existing `runMeetingRoomScheduledMaintenance`
body with a settled frontier and records the resulting safe head. The test
asserts ten safe heads, ten delivery-to-safe intervals of 25 ms, ten pass-body
runs, and zero cron invocations. The compact per-commit table is:

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

## Local gates

Passed: `npm run test:g67` (four focused tests, red-before-green receipt,
green receipt, and both mutants red), `npm run typecheck`, `npm run lint`,
`npm run test:g44`, `npm run test:g58`, `npm run test:g60:required`,
`npm run test:g61`, `npm run test:g62`, and `npm run test:g65:required`.
`git diff --check` is clean for the scoped checkpoint.

The first aggregate `npm run check` stopped in the unchanged G28 boundary
lane because npm could not write its log under the seat's root-owned
`~/.npm`. The identical aggregate with
`npm_config_cache=/private/tmp/sdt-g67-npm-cache` passed the boundary setup and
progressed through the repository tests, but its normal parallel Vitest run
reported two existing 5-second timeouts (`test/commit.spec.ts` AC7 and
`test/tag.spec.ts` G5; 767 passed, 1 skipped). Each exact test passed when
isolated with `--maxWorkers=1`. A serial aggregate with
`VITEST_MAX_WORKERS=1` reached the unchanged G32 parity lane and produced no
further output; it was timeboxed and terminated with exit 130. Its complete
log is preserved at `/private/tmp/sdt-g67-w142-check-serial.log` for local
diagnosis and is not a repository artifact. No G67 assertion, timeout, or
gate was changed to obtain these classifications.

## Remaining boundary

This checkpoint intentionally stops before AC4/AC5. It does not deploy to the
reused `sekiban-dcb-g60-w155-c` arm, reset operational data, or use the
production sample. A later continuation must run the same-arm baseline/post
cohorts and then the production cohort with observed clocks and pass triggers.

## W142 deployed arm measurement (blocked before production)

This section records the single W142 arm window. It is measurement evidence,
not an AC4/AC5 pass. The arm gate failed, so the production sample was not
reset or deployed.

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

W142 is **BLOCKED** at the isolated-arm gate. The exact candidate response
p95 miss (+206 ms versus the parent, over the +150 ms allowance) and safe p95
miss (117,661 ms versus 60,000 ms) prevent the authorized production sample.
No production resource was reset, deployed, or sampled. No code or
configuration change was made in this continuation. The earlier f5b2212
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

# SDT-G65 repair evidence (W129; W128 deployed baseline preserved)

Task: `SDT-G65-DEPLOYED-WAKE-128`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
Branch: `claude/sdt-g65-local-wake-w128`
Exact source deployed: `4184882c2d8779420e1778b95ea91d72676d4439`
Reviewed PR head: `68454969e6b9c15bb22e5e57bfd388167477dbfb`
Base: `origin/main` at `4687efa5c49951d9966a3785be5fd7b2620c6e4f`

W128 remains the preserved deployed baseline. This W129 checkpoint repairs the
four review findings and records the new local gates; it is **not** a claim that
the repaired source has deployed evidence yet. PR #127 remains in review and no
worker-complete, self-approval, or merge transition is performed here.

## Window and boundaries

The run reused the existing throwaway W155-C arm only:

| Resource | Identity |
| --- | --- |
| Worker | `sekiban-dcb-g60-w155-c` |
| Pipeline D1 | `sekiban-dcb-g60-w155-c-pipeline` / `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `sekiban-dcb-g60-w155-c-mv` / `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue | `sekiban-dcb-g60-w155-c-outbox` |
| Dead-letter Queue | `sekiban-dcb-g60-w155-c-outbox-dlq` |

No resource was created and no migration was applied. The normal config shape
was adapted only for this already-existing arm. All Wrangler calls were made
through the receipt-producing wrapper with these five credential variables
stripped; the seat state was `UNSET` for each: `CLOUDFLARE_API_TOKEN`,
`CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, and
`WRANGLER_API_TOKEN`. The conformance token was generated privately and passed
by file path only. No token value was printed, logged, or committed, and no
`--keep-vars` invocation was used.

The receipts are retained under [`.artifacts/`](.artifacts/). The important
remote operation receipts are `wrangler-001` through `wrangler-046`; the two
cohorts are [`sdt-g65-w128-baseline.json`](.artifacts/sdt-g65-w128-baseline.json),
[`sdt-g65-w128-post.json`](.artifacts/sdt-g65-w128-post.json), and the C-0
fault cohort/follow-up are [`sdt-g65-w128-d1-unavailable.json`](.artifacts/sdt-g65-w128-d1-unavailable.json)
and [`sdt-g65-w128-restored-followup.json`](.artifacts/sdt-g65-w128-restored-followup.json).

## Deployment identity

The pre-change baseline was collected before the exact G65 deployment. The
active secret-only version was `67e00b28-ecec-45e9-bb1d-6845464ecce3`; it had
no source message after the secret publication. The immediately preceding
W155 deployment was recorded as version
`b00974ad-cb17-4b44-a8ca-72a273416f71`, deployment
`58f5e182-...`, with annotation
`SDT-G60 W155 exact 31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf`.

The exact G65 deployment was:

| Item | Value |
| --- | --- |
| Version | `ee161e62-528f-4caa-98a6-943134b2d26c` |
| Deployment | `710638c8-84a2-4696-bc51-254b0c365570` |
| Annotation | `SDT-G65 W128 exact 4184882c2d8779420e1778b95ea91d72676d4439` |
| Traffic | 100% |
| D1 binding | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| D1_MV binding | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |

The C-0 runtime-D1-unavailable deployment used the same arm and omitted only
the runtime `D1` binding. It was version
`4665c82b-186a-4122-a8be-5ac8120b457e`. The normal binding was restored with
version `53ba7465-60e6-4773-ba69-e94bc29c2130`, deployment
`00dc3aba-dd45-4b84-b682-341eba6f4a64`, 100% traffic, and the exact annotation
`SDT-G65 W128 restore normal D1 exact 4184882c2d8779420e1778b95ea91d72676d4439`.

## AC5 — before/after cohorts (W128 preserved; repaired measurement required)

Both public cohorts were cold-first, n=10, paced at least ten seconds after the
preceding response, and used fully paged `GET /api/read/reservations`. The
percentiles below use the receipt's nearest-rank calculation. `unsafe` is
recorded evidence; the unchanged 5,000 ms contract is checked separately.

| Metric | Pre-change W155 baseline | Post-change G65 | Result |
| --- | ---: | ---: | --- |
| Client send-to-response n / p50 / p95 | 10 / 2,145 / 2,417 ms | 10 / 2,413 / 2,545 ms | p95 delta +128 ms; within 150 ms |
| Runtime body duration n / p50 / p95 | 10 / 1,179 / 1,382 ms | 10 / 1,499 / 1,600 ms | diagnostic only |
| Global `dcb_events` visibility | not measured with a completion clock | not validly measured in W128 | no timing claim |
| Unsafe first visibility | 10 / 4,529 / 4,778 ms | 10 / 2,262 / 4,518 ms | 0/10 over 5,000 ms in both |
| Safe/projector proof | 10 / 86,165 / 147,019 ms | 10 / 114,982 / 176,719 ms | 10/10 within 180 s |

For the post-change cohort, the durable ledger contains 11 `dcb_events` rows
(room plus ten reservations) and 21 global-receipt rows. Row presence and the
authored `dcb_events.Timestamp`/receipt `received_at` values do not establish a
global completion time. The W128 public adapter also did not expose the
admission header. Those fields are therefore not used to claim a global
visibility latency or a synchronous-admission duration.

### Post-change per-sample table

All rows are committed, uncensored, and have a tag-state read. `safe` is the
final projector/tag-state proof measured from the commit response receipt.

| # | SUID | Response | Body | Unsafe | Safe | Tag |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `063924170036450000001601242872` | 2,425 | 1,484 | 4,455 | 176,719 | 114,111 |
| 2 | `063924170048651000000943085258` | 2,213 | 1,496 | 4,402 | 164,504 | 101,896 |
| 3 | `063924170060926000000751541386` | 2,191 | 1,402 | 2,223 | 152,312 | 89,704 |
| 4 | `063924170073209000001265182147` | 2,340 | 1,508 | 4,351 | 139,969 | 77,361 |
| 5 | `063924170085685000000958948325` | 2,437 | 1,524 | 4,433 | 127,530 | 64,922 |
| 6 | `063924170098131000001782981253` | 2,545 | 1,600 | 2,262 | 114,982 | 52,374 |
| 7 | `063924170110698000000502397285` | 2,501 | 1,468 | 4,518 | 102,478 | 39,870 |
| 8 | `063924170123043000000823932601` | 2,413 | 1,564 | 2,223 | 90,063 | 27,455 |
| 9 | `063924170135495000000098441838` | 2,472 | 1,562 | 2,237 | 77,591 | 14,983 |
| 10 | `063924170147866000001751334201` | 2,303 | 1,499 | 2,240 | 65,287 | 2,679 |

Times are milliseconds. The old `338/412 ms` synchronous-admission figures
were derived from `received_at`/outbox observations and are withdrawn as
timing claims. W128 did not have the new correlated admission ledger or the
public outcome header, so no global completion distribution is claimed here.

### Durable hop and sub-hop measurements

The post-change raw and analyzed receipts are
[`sdt-g65-w128-analysis.json`](.artifacts/sdt-g65-w128-analysis.json),
[`wrangler-018-query-pipeline-dcb_events.json`](.artifacts/wrangler-018-query-pipeline-dcb_events.json),
[`wrangler-019-query-pipeline-serialized_dcb_global_receipts.json`](.artifacts/wrangler-019-query-pipeline-serialized_dcb_global_receipts.json),
[`wrangler-020-query-pipeline-serialized_dcb_hop_measurements.json`](.artifacts/wrangler-020-query-pipeline-serialized_dcb_hop_measurements.json),
[`wrangler-021-query-pipeline-serialized_dcb_hop_submeasurements.json`](.artifacts/wrangler-021-query-pipeline-serialized_dcb_hop_submeasurements.json),
and [`wrangler-022-query-pipeline-serialized_dcb_unsafe_writer_boundaries.json`](.artifacts/wrangler-022-query-pipeline-serialized_dcb_unsafe_writer_boundaries.json).

| Boundary | n / observed | p50 / p95 | Outcome or note |
| --- | ---: | ---: | --- |
| command receipt → tag append | 10 / 10 | 879 / 976 ms | all present |
| tag append → outbox obligation | 10 / 10 | 2 / 11 ms | all present |
| outbox → Queue send return | 10 / 10 | 224 / 315 ms | all present |
| Queue send → consumer start | 10 / 10 | 2,519 / 4,259 ms | dominant completed Queue interval |
| consumer start → recordDelivery commit | 10 / 10 | 690 / 856 ms | all present |
| recordDelivery → first unsafe observation | 10 / 10 | -276 / 1,271 ms | negative values are receipt-observation ordering, not causal negative work |
| post-record global-receipt readback | 10 / 10 | 58 / 134 ms | complete |
| source Tag acknowledgement | 10 / 10 | 144 / 196 ms | acknowledged |
| completeness coverage | 10 / 10 | 98 / 159 ms | all `BLOCK/UNSETTLED` |
| detector | 10 / 2 | 224 / 260 ms | 8 not separately recorded on duplicate/race paths |
| unsafe RoomProjector apply | 10 / 10 | 279 / 597 ms | apply/no-change outcomes present |
| unsafe ReservationProjector apply | 10 / 10 | 168 / 244 ms | apply/no-change outcomes present |
| inline unsafe Room writer | 10 / 10 | 58 / 286 ms | independent writer boundaries |
| inline unsafe Reservation writer | 10 / 10 | 55 / 68 ms | independent writer boundaries |

The durable writer trace proves unsafe apply while completeness was
`BLOCK/UNSETTLED`: inline-delivery Room and Reservation writer boundaries were
recorded, while the ordinary safe-lane view was not admitted by the completeness
gate. The independent unsafe path is therefore not waiting for a FULL safe
coverage result. The Queue replay is idempotent: the post cohort has one
ReservationProjector unsafe receipt per reservation, with duplicate/no-change
outcomes where the room and reservation fan-out met the same event, and no
regressing active row.

## Amended AC0 and AC5 evaluation (W128 baseline; W129 repair pending)

The absolute 1,308 ms figure was the SDT-G52 LAX measurement from a different
worker and colo and is withdrawn. It is not used as an acceptance target and
does not justify rerunning the already-complete W128 cohorts.

AC0 is satisfied by the bounded direct-doorbell contract: the documented
`G65_DERIVED_WRITE_BUDGET_MS = 300` budget returns the commit response even if
the receiver hangs, leaves the unsafe apply to the existing Queue fallback,
and records an unknown derived-write outcome rather than failing the commit.
The six unchanged SDT-G60 mutants remain green, and the G65 red-capable guard
proves a never-resolving receiver cannot delay the response beyond the budget.

The following is the W128 evaluation only. It is retained for comparison, but
the repaired source must produce a new healthy and unavailable measurement
before these values can be used as W129 acceptance evidence:

| Check | Calculation | Result |
| --- | --- | --- |
| Client response p95 | `2,545 − 2,417 = 128 ms` | PASS; ≤150 ms |
| Client response p50 increase | `2,413 − 2,145 = 268 ms` | W128 historical only; no W129 claim |
| Global visibility | no valid W128 completion/read clock | OPEN; not claimed |
| Unsafe visibility | post p50/p95 `2,262/4,518 ms` | PASS; 0/10 at or over 5,000 ms |
| Safe visibility | post p50/p95 `114,982/176,719 ms` | PASS; 10/10 within 180 s |
| HTTP 504 | post cohort | PASS; 0/10 |

The direct unsafe-writer boundaries remain bounded (`RoomProjector` p50/p95
`58/286 ms`, `ReservationProjector` `55/68 ms`), but W128 did not record a
correlated admission start/end/outcome ledger or a valid global completion
clock. The repair adds `serialized_dcb_g65_admission_attempts`, whose
timestamps are `Date.now()` epoch milliseconds captured at the real bounded
attempt and whose successful completion means the shared `recordDelivery`
read-back returned. A fresh deployed repair measurement is required before
claiming the global/admission distributions or separating the doorbell and
synchronous contributions.

## AC5 D1-unavailable cohort

Under C-0 only the runtime `D1` binding was removed. The three commits remained
HTTP 200 `kind=committed`; no commit was rejected. The public RYOW/list read
was explicitly missing at the 5,000 ms observation bound for all three. The
raw script inherited the string `missing-by-120000ms`; the actual command bound
was 5,000 ms, so this report calls the result **missing at 5 s**, not censored
at 120 s.

| # | SUID | Commit response | Body duration | Public read at 5 s | W128 header | After D1 restore |
| ---: | --- | ---: | ---: | --- | ---: |
| 1 | `063924170522202000000609209965` | 2,267 ms | 1,034 ms | missing | absent | visible once at 110,803 ms |
| 2 | `063924170534358000000800833193` | 2,106 ms | 1,008 ms | missing | absent | visible once at 98,858 ms |
| 3 | `063924170546383000001678223877` | 1,987 ms | 928 ms | missing | absent | visible once at 87,014 ms |

After the normal D1 binding was restored, the three pending events were
admitted by Queue processing and each reservation became visible exactly once.
The corrected durable queries show one ReservationProjector `applied` unsafe
receipt per reservation, one RoomProjector `no-change` receipt per reservation,
four unsafe rows including the setup room, and no duplicate/regressing
reservation row. The relevant receipts are
[`wrangler-041-query-unavailable-events-corrected.json`](.artifacts/wrangler-041-query-unavailable-events-corrected.json),
[`wrangler-042-query-unavailable-receipts-corrected.json`](.artifacts/wrangler-042-query-unavailable-receipts-corrected.json),
[`wrangler-043-query-unavailable-hops-corrected.json`](.artifacts/wrangler-043-query-unavailable-hops-corrected.json),
[`wrangler-044-query-unavailable-mv-receipts-corrected.json`](.artifacts/wrangler-044-query-unavailable-mv-receipts-corrected.json),
and [`wrangler-046-query-unavailable-mv-unsafe-rows.json`](.artifacts/wrangler-046-query-unavailable-mv-unsafe-rows.json).

## W129 local repair evidence (F1–F4)

F1 removes the request-path dependency on the source-partition registration
probe. The public SQL append now schedules that post-commit observation without
turning its failure or hang into a 503. The D1 `recordDelivery` batch atomically
upserts the source partition together with the event, global membership, and
receipt, so a successful global admission has precise G44 source authority;
the safe fence remains fail-closed when that batch is absent or fails. The new
SQLite/public test uses an unavailable runtime D1 binding and still receives a
committed response, while the D1 batch failure test proves no partial global
admission rows are left behind.

F2 replaces the private in-memory admission map with real D1/shared-path
coverage: direct-first and Queue-first order, duplicate replay, conflicting
identity, and atomic batch failure are exercised. The guard's omission,
unbounded wait, response-gating, durability-order, duplicate, and direct-path
mutants all produce red receipts; no G60 mutant was changed.

F3 withdraws authored `Timestamp` and caller/outbox `received_at` values as
global timing claims. The new `serialized_dcb_g65_admission_attempts` ledger
correlates event/SUID/attempt identity, records `Date.now()` epoch-ms start/end,
outcome, completion observation, and clock origin through `waitUntil`; it never
controls admission or response. A fresh deployment is required for its
distributions and for separating the bounded doorbell contribution from the
explicit synchronous-admission attempt.

F4 preserves the V1 JSON body and exposes the actual admission outcome through
the additive `x-sdt-global-admission` header (`admitted`, `not-admitted`, or
`unknown`). The transport now retains response headers; unit coverage asserts
both the header and unchanged JSON shape. The write-path evidence describes the
G35 inheritance boundary and Queue ordering explicitly.

## AC6 and AC7 local evidence

The local red/green/mutant proof from W128 remains unchanged. The focused
`test:g65` runner is green and records all six expected red mutants: omitted
synchronous admission, unbounded doorbell, response gated on D1, reordered
durability, duplicate admission, and omitted direct delivery. The existing
G60 red-capable guards remained unmodified and green, including direct-doorbell,
Queue-latency, durable-hop, unsafe-writer, and post-admission guards.

The deployed observations preserve the V1 response body, event/tag ordering,
reservation and fence protocol, Queue durability/retry/DLQ ownership, safe-lane
completeness semantics, G58/G62 maintenance behavior, and the unchanged
5,000 ms constant. No gate was weakened, skipped, or timeout-inflated.

## Gate results

The following commands were rerun on the W129 repair checkpoint and exited
zero. Expected red/mutant cases are reported inside their passing runners:

| Gate | Result |
| --- | --- |
| `npm run test:g65` | PASS; 4 focused tests and six red mutants |
| `npm run test:g60:required` | PASS; unchanged G60 guards/mutants |
| `npm run test:g26` | PASS; 32 tests |
| `npm run test:g29:mapping` | PASS; 92 tests and mapping runner |
| `npm run test:g29:delivery` | PASS; 7 tests and delivery matrix |
| `npm run test:g29:diagnostics` | PASS; 12 tests |
| `npm run test:g29:compatibility` | PASS; 5 tests |
| `npm run test:g41` | PASS; production mutants red; existing Vitest teardown warning did not change exit 0 |
| `npm run test:g44` | PASS; atomic production mutants red |
| `npm run test:g49` | PASS; binding/migration/lineage mutants red |
| `npm run test:g51` | PASS; native span/guard runners |
| `npm run test:g52` | PASS; 18 tests and omission mutants red |
| `npm run test:g53` | PASS; scope/control/downstream mutants red |
| `npm run test:g54` | PASS; 18 tests and production omission mutants red |
| `npm run test:g55` | PASS; 12 tests and read-visibility mutations red |
| `npm run test:g56` | PASS; assert-empty contract and omission mutant red |
| `npm run test:g58` | PASS; 15 tests and existing G58 red-capable guards |
| `npm run test:g61` | PASS; retained-frontier red-before-green and mutant red |
| `npm run test:g62` | PASS; cursor-aware guards and three mutants red |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |

There is no `test:g63` script in `package.json`; no G63 gate was silently
substituted or weakened.

## W129 rereview boundary

The local repair checkpoint satisfies the code/test portion of F1–F4 and
preserves the W128 deployed receipts, but AC5/F1/F3/F4 fresh deployed proof is
still required before PR #127 can be marked rereview-ready. No new Cloudflare
operation is included in this local evidence update. The six G60 mutants, V1
body, fence, Queue/outbox, G58/G62, and 5,000 ms boundaries remain unchanged.
SDT-G57 is not touched.

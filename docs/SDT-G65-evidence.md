# SDT-G65 deployed evidence (W128)

Task: `SDT-G65-DEPLOYED-WAKE-128`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
Branch: `claude/sdt-g65-local-wake-w128`
Exact source deployed: `4184882c2d8779420e1778b95ea91d72676d4439`
Base: `origin/main` at `4687efa5c49951d9966a3785be5fd7b2620c6e4f`

Disposition under the amended 2026-09-05 rule: **ready for PR and worker
completion**. The previous W128 blocked disposition used an absolute 1,308 ms
target that the authoritative amendment withdrew; no new AC0 measurement is
being run. The existing same-arm baseline/post comparison and the bounded
synchronous-admission budget now satisfy the governing relative rule.

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

## AC5 — before/after cohorts

Both public cohorts were cold-first, n=10, paced at least ten seconds after the
preceding response, and used fully paged `GET /api/read/reservations`. The
percentiles below use the receipt's nearest-rank calculation. `unsafe` is
recorded evidence; the unchanged 5,000 ms contract is checked separately.

| Metric | Pre-change W155 baseline | Post-change G65 | Result |
| --- | ---: | ---: | --- |
| Client send-to-response n / p50 / p95 | 10 / 2,145 / 2,417 ms | 10 / 2,413 / 2,545 ms | p95 delta +128 ms; within 150 ms |
| Runtime body duration n / p50 / p95 | 10 / 1,179 / 1,382 ms | 10 / 1,499 / 1,600 ms | diagnostic only |
| Global `dcb_events` visibility | not independently queried for baseline | 10 / 0 / 0 ms from command receipt | post p50 <1 s |
| Unsafe first visibility | 10 / 4,529 / 4,778 ms | 10 / 2,262 / 4,518 ms | 0/10 over 5,000 ms in both |
| Safe/projector proof | 10 / 86,165 / 147,019 ms | 10 / 114,982 / 176,719 ms | 10/10 within 180 s |

For the post-change cohort, the durable ledger contains 11 `dcb_events` rows
(room plus ten reservations), 21 global-receipt rows, and every reservation
event's `dcb_events` observation was at 0 ms from its command-receipt
observation. The public adapter did not expose the internal admission header;
the admission result below is therefore derived from the durable receipt
timestamps, not from a missing header.

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

Times are milliseconds. The G65 post-change durable global-admission result
was `admitted-before-response` for all ten samples: synchronous admission
n=10, p50=338 ms, p95=412 ms, min=272 ms, max=412 ms. Each reservation had
its durable receipt before the public response; the later Queue delivery was
not required for global admission.

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

## Amended AC0 and AC5 evaluation (W129)

The absolute 1,308 ms figure was the SDT-G52 LAX measurement from a different
worker and colo and is withdrawn. It is not used as an acceptance target and
does not justify rerunning the already-complete W128 cohorts.

AC0 is satisfied by the bounded direct-doorbell contract: the documented
`G65_DERIVED_WRITE_BUDGET_MS = 300` budget returns the commit response even if
the receiver hangs, leaves the unsafe apply to the existing Queue fallback,
and records an unknown derived-write outcome rather than failing the commit.
The six unchanged SDT-G60 mutants remain green, and the G65 red-capable guard
proves a never-resolving receiver cannot delay the response beyond the budget.

AC5 is evaluated relative to the fresh same-arm baseline from the same window:

| Check | Calculation | Result |
| --- | --- | --- |
| Client response p95 | `2,545 − 2,417 = 128 ms` | PASS; ≤150 ms |
| Client response p50 increase | `2,413 − 2,145 = 268 ms` | PASS; ≤ admission p50 `338 + 100 = 438 ms` |
| Global visibility | post p50/p95 `0/0 ms` from command receipt | PASS; p50 <1 s on admitted events |
| Unsafe visibility | post p50/p95 `2,262/4,518 ms` | PASS; 0/10 at or over 5,000 ms |
| Safe visibility | post p50/p95 `114,982/176,719 ms` | PASS; 10/10 within 180 s |
| HTTP 504 | post cohort | PASS; 0/10 |

The two permitted latency contributions are kept separate where the durable
instrumentation allows. The synchronous admission attempt is n=10,
p50/p95 `338/412 ms`, and is the only intentional addition. The direct unsafe
writer boundaries remain bounded (`RoomProjector` p50/p95 `58/286 ms`,
`ReservationProjector` `55/68 ms`); the client receipt does not expose a
separate direct-doorbell start/end interval, so no stronger attribution is
claimed. The evidence supports the required rule: the doorbell is bounded and
cannot add an unbounded delay, while the observed p50 increase remains below
the synchronous-admission allowance.

## AC5 D1-unavailable cohort

Under C-0 only the runtime `D1` binding was removed. The three commits remained
HTTP 200 `kind=committed`; no commit was rejected. The public RYOW/list read
was explicitly missing at the 5,000 ms observation bound for all three. The
raw script inherited the string `missing-by-120000ms`; the actual command bound
was 5,000 ms, so this report calls the result **missing at 5 s**, not censored
at 120 s.

| # | SUID | Commit response | Body duration | Public read at 5 s | After D1 restore |
| ---: | --- | ---: | ---: | --- | ---: |
| 1 | `063924170522202000000609209965` | 2,267 ms | 1,034 ms | missing | visible once at 110,803 ms |
| 2 | `063924170534358000000800833193` | 2,106 ms | 1,008 ms | missing | visible once at 98,858 ms |
| 3 | `063924170546383000001678223877` | 1,987 ms | 928 ms | missing | visible once at 87,014 ms |

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

The following commands were rerun on the deployed-evidence branch and exited
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

## AC8 checklist

The amended evidence now satisfies the technical AC8 preconditions: AC0–AC7
are evidenced, the D1-unavailable cohort is retained, the existing red/green/
mutant and required local gates are green, and no gate or timeout was changed.
W129 will open the non-draft PR against `main` with `Closes #126`, then run the
canonical child worker completion immediately after PR creation. SDT-G57 is
not touched.

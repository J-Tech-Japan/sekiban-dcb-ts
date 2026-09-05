# SDT-G65 repair evidence (W129; W128 baseline and W129 repair deployment)

Task: `SDT-G65-PR127-REPAIR-WAKE-129`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
Branch: `claude/sdt-g65-local-wake-w128`
Exact source deployed for W129: `ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`
Reviewed PR head: `68454969e6b9c15bb22e5e57bfd388167477dbfb`
Base: `origin/main` at `4687efa5c49951d9966a3785be5fd7b2620c6e4f`

W128 remains the preserved deployed baseline. W129 repairs the four review
findings, records the local red/green/mutant gates, and deploys the exact repair
to the existing W155-C arm for the required healthy and runtime-D1-unavailable
proofs. PR #127 remains in review; no worker-complete, self-approval, or merge
transition is performed here.

## Window and boundaries

The run reused the existing throwaway W155-C arm only:

| Resource | Identity |
| --- | --- |
| Worker | `sekiban-dcb-g60-w155-c` |
| Pipeline D1 | `sekiban-dcb-g60-w155-c-pipeline` / `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `sekiban-dcb-g60-w155-c-mv` / `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue | `sekiban-dcb-g60-w155-c-outbox` |
| Dead-letter Queue | `sekiban-dcb-g60-w155-c-outbox-dlq` |

No resource was created. Migration `0009_g65_admission_attempts.sql` was
applied exactly once to the existing pipeline D1; the first stripped
`migrations list` read returned Cloudflare code 7403, and the permitted
idempotent read retry after approximately five seconds succeeded before the
single apply. The normal config shape was adapted only for this already-existing
arm. All Wrangler calls were made
through the receipt-producing wrapper with these five credential variables
stripped; the seat state was `UNSET` for each: `CLOUDFLARE_API_TOKEN`,
`CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, and
`WRANGLER_API_TOKEN`. The conformance token was generated privately and passed
by file path only. No token value was printed, logged, or committed, and no
`--keep-vars` invocation was used.

The receipts are retained under [`.artifacts/`](.artifacts/). The important
remote operation receipts are `wrangler-001` through `wrangler-046` plus the
W129 receipts listed below; the two
cohorts are [`sdt-g65-w128-baseline.json`](.artifacts/sdt-g65-w128-baseline.json),
[`sdt-g65-w128-post.json`](.artifacts/sdt-g65-w128-post.json), and the C-0
fault cohort/follow-up are [`sdt-g65-w128-d1-unavailable.json`](.artifacts/sdt-g65-w128-d1-unavailable.json)
and [`sdt-g65-w128-restored-followup.json`](.artifacts/sdt-g65-w128-restored-followup.json).

## W129 deployment identity

The W129 normal deployment was version
`0be239ed-5553-4f0b-b29a-1c344b082de1`, deployment
`46d79582-80c9-49c2-852d-2585021b6f8f`, 100% traffic, with annotation
`SDT-G65 W129 repair exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a` and the
expected pipeline/MV bindings. No secret publication was needed, so no
secret-created version intervened. The exact receipts are
[`sdt-g65-w129-deploy-normal.log`](.artifacts/sdt-g65-w129-deploy-normal.log),
[`sdt-g65-w129-versions-normal.json`](.artifacts/sdt-g65-w129-versions-normal.json),
and [`sdt-g65-w129-deployments-normal.json`](.artifacts/sdt-g65-w129-deployments-normal.json).

The runtime-D1-unavailable proof deployed the same exact source with only the
runtime `D1` binding removed: version
`51b6a2a6-968b-475d-b679-cb519e84d0fc`, deployment
`9be2e34d-75f9-4881-8b6d-5432522f3975`, 100% traffic, annotation
`SDT-G65 W129 F1 unavailable-D1 exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`.
The normal binding was restored afterward with version
`2b1dae1e-5b3d-4c48-8e64-67a8cf64b850`, deployment
`d1b85541-6339-4f41-a3ae-10f0f260264b`, 100% traffic, annotation
`SDT-G65 W129 restore normal D1 exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`.
The unavailable and restore receipts are
[`sdt-g65-w129-deploy-d1-unavailable.log`](.artifacts/sdt-g65-w129-deploy-d1-unavailable.log),
[`sdt-g65-w129-deployments-d1-unavailable.json`](.artifacts/sdt-g65-w129-deployments-d1-unavailable.json),
and [`sdt-g65-w129-deployments-final.json`](.artifacts/sdt-g65-w129-deployments-final.json).

The W129 healthy public receipt is preserved losslessly as
[`sdt-g65-w129-healthy-cohort.json.gz`](.artifacts/sdt-g65-w129-healthy-cohort.json.gz).
Its SHA-256 is
`691257836b8e5cb9e1d3d78df6f6c589f079eafd000f973a953d65b9cb626667`; the
lossless decompression command is
`gzip -dc .artifacts/sdt-g65-w129-healthy-cohort.json.gz > .artifacts/sdt-g65-w129-healthy-cohort.json`.
The decompressed stream was verified byte-for-byte against the locally retained
expanded receipt. The unavailable public receipt is
[`sdt-g65-w129-d1-unavailable.json`](.artifacts/sdt-g65-w129-d1-unavailable.json).

The five recognized Wrangler credential variables were `UNSET` for every
W129 invocation: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`. The conformance
credential was path-only; no token value was printed, logged, or committed.

## Deployment identity (W128 historical baseline)

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

## AC5 — before/after cohorts (W128 preserved; W129 repair measurement)

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

### W129 deployed healthy cohort

The exact W129 repair ran one cold-first, ten-sample public cohort on the same
W155-C arm. Samples were paced at least ten seconds after the preceding commit
response. The public body remained V1-compatible; the additive
`x-sdt-global-admission` header was `unknown` for all ten samples. The durable
ledger explains that result: all 11 command-associated attempts (setup room plus
ten reservations) finished at the 300 ms bounded deadline with outcome
`unknown` and no `global_completion_observed_at`. This is recorded evidence,
not a false admission pass.

| Metric | W129 result | Interpretation |
| --- | ---: | --- |
| Client response n / p50 / p95 | 10 / 2,197 / 3,356 ms | response distribution |
| Unsafe first visibility n / p50 / p95 | 10 / 56,642 / 118,113 ms | evidence only; 10/10 over 5,000 ms |
| Safe/projector head n / p50 / p95 | 10 / 172,470 / 235,238 ms | 5/10 within 180 s; 5/10 after the bound |
| Cohort tag-state reads | 11/11 version 1 | committed tag state |
| Final Room/Reservation heads | both `063924178322440000001456939849` | reached after the 180 s bound |

| # | SUID | Response | Unsafe | Safe/head | Tag state |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | `063924178210984000001726691723` | 2,518 | 118,113 | 235,238 | 117,926 |
| 2 | `063924178224722000000360555581` | 3,356 | 104,403 | 221,303 | 103,991 |
| 3 | `063924178237013000002045136300` | 2,066 | 92,575 | 209,236 | 91,924 |
| 4 | `063924178249243000000862815092` | 2,235 | 80,542 | 196,992 | 79,680 |
| 5 | `063924178261468000000443208851` | 2,197 | 68,721 | 184,794 | 67,482 |
| 6 | `063924178273513000001618644650` | 2,323 | 56,642 | 172,470 | 55,158 |
| 7 | `063924178285821000001542062552` | 2,017 | 44,898 | 160,452 | 43,140 |
| 8 | `063924178298169000001652676251` | 2,356 | 32,874 | 148,094 | 30,782 |
| 9 | `063924178310280000000037521988` | 2,089 | 36,310 | 136,004 | 18,692 |
| 10 | `063924178322440000001456939849` | 2,194 | 24,294 | 123,809 | 6,497 |

The W129 raw receipt is compressed and retained above. It records 68 health
snapshots, per-sample public paging, tag-state reads, scheduled polls, and the
final projector-head proof. Because this repair task does not authorize a
further latency repair, the W129 5 s/180 s misses remain honest platform
evidence; they do not get relabeled as a G65 pass.

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

### W129 admission ledger

The W129 ledger query is preserved in
[`sdt-g65-w129-ledger-query.log`](.artifacts/sdt-g65-w129-ledger-query.log).
It contains 36 rows for 11 distinct event identities/attempt identities after
the setup row and cohort reservations are correlated. Every row has
`clock_origin = Date.now epoch ms`, a 300 ms start-to-finish bounded attempt,
`outcome = unknown`, and a null global-completion observation. Therefore the
W129 admission distribution is n=11, p50=300 ms, p95=300 ms for the bounded
attempt itself, with admitted=0, not-admitted=0, unknown=11. The public healthy
cohort independently records the same `unknown` outcome header for 10/10
reservations. The runtime-D1-unavailable proof records `not-admitted` on its
public reservation response, while the commit body remains HTTP 200 and
`kind=committed`; its raw receipt is retained below.

## Amended AC0 and AC5 evaluation (W128 baseline plus W129 evidence)

The absolute 1,308 ms figure was the SDT-G52 LAX measurement from a different
worker and colo and is withdrawn. It is not used as an acceptance target and
does not justify rerunning the already-complete W128 cohorts.

AC0 is satisfied by the bounded direct-doorbell contract: the documented
`G65_DERIVED_WRITE_BUDGET_MS = 300` budget returns the commit response even if
the receiver hangs, leaves the unsafe apply to the existing Queue fallback,
and records an unknown derived-write outcome rather than failing the commit.
The six unchanged SDT-G60 mutants remain green, and the G65 red-capable guard
proves a never-resolving receiver cannot delay the response beyond the budget.

The following W128 evaluation is retained for comparison only:

| Check | Calculation | Result |
| --- | --- | --- |
| Client response p95 | `2,545 − 2,417 = 128 ms` | PASS; ≤150 ms |
| Client response p50 increase | `2,413 − 2,145 = 268 ms` | W128 historical only; no W129 claim |
| Global visibility | no valid W128 completion/read clock | W128 OPEN; not claimed |
| Unsafe visibility | post p50/p95 `2,262/4,518 ms` | PASS; 0/10 at or over 5,000 ms |
| Safe visibility | post p50/p95 `114,982/176,719 ms` | PASS; 10/10 within 180 s |
| HTTP 504 | post cohort | PASS; 0/10 |

For W129, the actual admission outcome is exposed through the documented V1
compatible response header. Healthy arm: `unknown` 10/10, because the bounded
attempt exhausted before a global completion read-back. Runtime D1 unavailable:
`not-admitted` on the one reservation, while the local SQLite commit stayed
HTTP 200/`committed`. This distinguishes response acceptance from global
admission and does not swallow the G44 obligation.

The direct unsafe-writer boundaries remain bounded (`RoomProjector` p50/p95
`58/286 ms`, `ReservationProjector` `55/68 ms`), but W128 did not record a
correlated admission start/end/outcome ledger or a valid global completion
clock. The repair adds `serialized_dcb_g65_admission_attempts`, whose
timestamps are `Date.now()` epoch milliseconds captured at the real bounded
attempt and whose successful completion means the shared `recordDelivery`
read-back returned. A fresh deployed repair measurement is required before
claiming the global/admission distributions or separating the doorbell and
synchronous contributions.

## W128 historical AC5 D1-unavailable cohort

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

## W129 F1 runtime-D1-unavailable proof

W129 repeated the unavailable-binding proof against the exact repair source with
one cold-first public reservation (the setup room is separate). The runtime D1
binding was absent, while local SQLite remained available. The commit returned
HTTP 200 with body `kind=committed`, the additive admission header was
`not-admitted`, and the fully paged public reservation list did not contain the
new reservation at the 5,000 ms observation bound. The raw receipt records
`n=1`, observed `0`, censored `1`, and `countAtOrOver5000OrMissing=1`; no
percentile is claimed from this one censored row. After restoring the normal D1
binding, the arm was left on the normal exact-source deployment recorded above.

| Sample | Commit response | Admission header | Public read | Interpretation |
| ---: | ---: | --- | --- | --- |
| 1 | HTTP 200, `committed`, 1,939 ms | `not-admitted` | missing at 5 s | local durable acceptance is independent of the unavailable D1 probe; global admission is explicit |

Receipt: [`sdt-g65-w129-d1-unavailable.json`](.artifacts/sdt-g65-w129-d1-unavailable.json).
The deployment and restoration receipts are
[`sdt-g65-w129-deploy-d1-unavailable.log`](.artifacts/sdt-g65-w129-deploy-d1-unavailable.log)
and [`sdt-g65-w129-deploy-restore-normal.log`](.artifacts/sdt-g65-w129-deploy-restore-normal.log).

## W129 local repair evidence (F1–F4)

F1 removes the request-path dependency on the source-partition registration
probe. The public SQL append now schedules that post-commit derived obligation
with three bounded attempts; a schema-probe or INSERT failure/hang cannot turn
the durable local commit into a 503. The D1 `recordDelivery` batch atomically
upserts the source partition together with the event, global membership, and
receipt, so a successful global admission has precise G44 source authority;
the safe fence remains fail-closed when that batch is absent or fails. Real
SQLite/public tests cover an unavailable runtime D1 binding, a hanging schema
probe, and an INSERT failure, and all return the committed response; the D1
batch failure test proves no partial global-admission rows are left behind.

F2 replaces the private in-memory admission map with real D1/shared-path
coverage: direct-first and Queue-first order, duplicate replay, conflicting
identity, and atomic batch failure are exercised. The guard's omission,
unbounded wait, response-gating, durability-order, duplicate, and direct-path
mutants all produce red receipts; no G60 mutant was changed.

F3 withdraws authored `Timestamp` and caller/outbox `received_at` values as
global timing claims. The new `serialized_dcb_g65_admission_attempts` ledger
correlates event/SUID/attempt identity, records `Date.now()` epoch-ms start/end,
outcome, completion observation, and clock origin through `waitUntil`; it never
controls admission or response. W129 deployed evidence records the bounded
attempt distribution above. It also keeps the bounded direct-doorbell and the
explicit synchronous-admission attempt as separate concepts; no unsupported
causal timing claim is made.

F4 preserves the V1 JSON body and exposes the actual admission outcome through
the additive `x-sdt-global-admission` header (`admitted`, `not-admitted`, or
`unknown`). The transport retains response headers, while its internal
admission association is a non-enumerable WeakMap entry rather than an
`ExecuteResult` body field. Unit coverage asserts all three header outcomes and
the unchanged JSON shape. The write-path evidence describes the G35
inheritance boundary and Queue ordering explicitly.

## W130 local repair and forced-red classification

W130 starts from PR #127 head `62c1272a3edc8e1f8833e2af73a910c9a4010f4f` and
is local-only. The G21–G25 package scripts and required CI steps were already
present on that exact head and were verified rather than duplicated or
weakened. Each `SDT_G2x_FORCE_FAILURE=1 npm run test:g2x:forced-red` probe
returned exit 1 after its normal lane completed, as required. The pinned CI
run's actual step records likewise showed all five forced-red steps succeeding
as guards; its failure was the unrelated G54 one-millisecond duration flake,
not an absent G21–G25 step. A forced-red probe that exits 0 remains a failed
guard by contract.

The corrected G65 guard retains a pre-change red receipt against
`68454969e6b9c15bb22e5e57bfd388167477dbfb`, fixes the mutant helper so a
detected mutant is red while an undetected mutant fails the guard, and records
the bounded source-registration wiring. Its green receipt covers the real D1
shared path, public SQLite append, header/body surface, and all six unchanged
G60 mutation classes. No G21–G25 gate, timeout, or unrelated G54 assertion was
changed. The durable receipts are
[`sdt-g65-w130-pre-change-red.json`](.artifacts/sdt-g65-w130-pre-change-red.json),
[`sdt-g65-w130-green-and-mutants.json`](.artifacts/sdt-g65-w130-green-and-mutants.json),
and [`sdt-g65-w130-g21-g25-forced-red.json`](.artifacts/sdt-g65-w130-g21-g25-forced-red.json).

## AC6 and AC7 local evidence

The local red/green/mutant proof from W128 remains unchanged. The focused
`test:g65` runner is green and records all six expected red mutants: omitted
synchronous admission, unbounded doorbell, response gated on D1, reordered
durability, duplicate admission, and omitted direct delivery. The existing
G60 red-capable guards remained unmodified and green, including direct-doorbell,
Queue-latency, durable-hop, unsafe-writer, and post-admission guards.

The W129 deployed observations preserve the V1 response body, event/tag ordering,
reservation and fence protocol, Queue durability/retry/DLQ ownership, safe-lane
completeness semantics, G58/G62 maintenance behavior, and the unchanged
5,000 ms constant. No gate was weakened, skipped, or timeout-inflated.

## Gate results

The following commands were rerun on the W129 repair checkpoint and exited
zero. Expected red/mutant cases are reported inside their passing runners:

| Gate | Result |
| --- | --- |
| `npm run test:g65` | PASS; 8 focused tests and six red mutants |
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

The repair checkpoint satisfies the code/test portion of F1–F4 and the W129
deployed evidence is now preserved. PR #127 is pushed at the repair head and
awaits reviewer rereview; no self-approval, merge, or worker-complete
transition is performed here. The six G60 mutants, V1 body, fence,
Queue/outbox, G58/G62, and 5,000 ms boundaries remain unchanged. SDT-G57 is
not touched.

## W130 deployed F1/F3/F4 evidence

W130 is the authorized deployed evidence continuation for PR #127 at exact
source `557aa1b1b78328866538f3c3fb56d3d529996994` on the existing throwaway
arm `sekiban-dcb-g60-w155-c`. No Worker, D1, Queue, DLQ, migration, or secret
was created or changed. Every Wrangler receipt was executed through the
stripped wrapper with `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN` all `UNSET`, and
`noKeepVars=true`. Conformance was referenced by path only.

The first cohort was captured before the exact-source deployment while the
arm ran the restored current-main source `ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`:
version `2b1dae1e-5b3d-4c48-8e64-67a8cf64b850`, deployment
`d1b85541-6339-4f41-a3ae-10f0f260264b`, 100% traffic. The exact-source
deployment was version `443416d2-204e-442a-af96-3400532bdcf6`, deployment
`acff763a-7346-4fb5-af7d-e49fba5c647c`, 100% traffic, annotation
`SDT-G65 W130 exact 557aa1b1b78328866538f3c3fb56d3d529996994`. After the
failure proof below, the normal binding was restored without another source
change: version `f7d3f08e-c56c-4b5c-b14a-8afe931cc2a9`, deployment
`be0bf5d9-51f6-4c1f-9d17-f9b17eeecf53`, 100% traffic, with the same exact
source annotation.

### Observed-clock policy and cohort summary

All times in the tables below come from the harness fetch/response clocks or
the durable W125/W127 ledger `Date.now()` boundaries. The analysis never uses
`dcb_events.authored_timestamp`, caller `received_at`, or
`serialized_dcb_global_receipts.received_at` as a completion or visibility
clock. The ledger's post-record-delivery global-receipt readback is reported as
an observed operational read, not as a proven admission completion. Its
observer persistence can occur after a public read; no ordering is inferred
from that mismatch.

| arm | n | response p50/p95 | commit→ledger readback end p50/p95 | commit→first public unsafe p50/p95 | >5,000 ms | final safe proof p50/p95 | within 180 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| pre-deploy `ccfa0b0` | 10 | 2,063 / 2,429 ms | 3,855 / 6,037 ms | 4,548 / 116,615 ms | 3/10 | 141,066 / 202,629 ms | no |
| exact `557aa1b` | 10 | 2,160 / 2,935 ms | 31,111 / 50,819 ms | 57,402 / 116,763 ms | 10/10 | 180,973 / 241,966 ms | no |

The final safe proof is the per-sample projector/tag-state proof, not a claim
that a separate public safe-read endpoint was observed. In both cohorts the
two final projector heads eventually reached the cohort final SUID and all 11
cohort tag-state reads returned committed version 1, but the safe-bound
acceptance was not met. Pre-deploy final head:
`063924187134766000002028023507`; exact-source final head:
`063924187626366000000264870134`. The sampled health surface reported
`SETTLED`; the durable per-event completeness rows are retained separately
and include `BLOCK/UNSETTLED` outcomes.

Every reservation's synchronous partition/admission attempt lasted 300 ms and
returned `unknown`; `global_completion_observed_at` was null for all 20
reservation rows. The internal readback and the public-read clocks are both
preserved, but are not substituted for that missing admission completion.

### Exact per-sample table

`safe-final` is commit response to the final projector/tag-state proof. The
`global-readback-end` value is the observed epoch-millisecond end of the
post-record-delivery readback. `admission` is exact start–end epoch
milliseconds, duration, and outcome. `header` is the caller-visible
`x-sdt-global-admission` outcome; the valid V1 body has no admission member.

#### Pre-deploy baseline

| # | event id | SUID | response | global-readback-end | unsafe | safe-final | admission | header |
| ---: | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `01a07048-ee2e-727c-a4b0-672a058fc677` | `063924187023565000001940658979` | 1839 | 1788590230187 | 116615 | 202629 | 1788590223773–1788590224073 / 300 / unknown | unknown |
| 2 | `01a07049-1d0a-774f-af13-8f82625578fd` | `063924187035546000000561067412` | 1958 | 1788590239966 | 4534 | 190668 | 1788590235760–1788590236060 / 300 / unknown | unknown |
| 3 | `01a07049-4be1-746d-8144-b5e0df499ee1` | `063924187047588000000012688801` | 2027 | 1788590252338 | 5117 | 178641 | 1788590247793–1788590248093 / 300 / unknown | unknown |
| 4 | `01a07049-7bbe-7475-a32d-23b3018aacdc` | `063924187059927000001181918520` | 2360 | 1788590264504 | 4541 | 166279 | 1788590260138–1788590260438 / 300 / unknown | unknown |
| 5 | `01a07049-ac95-74aa-988e-fcb9fd86d779` | `063924187072442000001826598279` | 2332 | 1788590277552 | 4431 | 153747 | 1788590272657–1788590272957 / 300 / unknown | unknown |
| 6 | `01a07049-de98-7926-a475-ccc4d89f9579` | `063924187085086000000809079851` | 2385 | 1788590289560 | 4608 | 141066 | 1788590285300–1788590285600 / 300 / unknown | unknown |
| 7 | `01a0704a-0f95-762a-ae18-7e13c75e9f86` | `063924187097634000000578712760` | 2429 | 1788590302329 | 4554 | 128283 | 1788590297837–1788590298137 / 300 / unknown | unknown |
| 8 | `01a0704a-40ef-7f6e-9342-1e0dd554d2dd` | `063924187110278000000381160128` | 2063 | 1788590313994 | 4502 | 115906 | 1788590310496–1788590310796 / 300 / unknown | unknown |
| 9 | `01a0704a-7167-71d1-8e59-d3f7b4e5001c` | `063924187122709000002034737008` | 2248 | 1788590327263 | 5158 | 103458 | 1788590322928–1788590323228 / 300 / unknown | unknown |
| 10 | `01a0704a-a0b2-7d3d-bb6d-f7fc2d35eb99` | `063924187134766000002028023507` | 2011 | 1788590338890 | 4548 | 91445 | 1788590334981–1788590335281 / 300 / unknown | unknown |

#### Exact-source healthy cohort

| # | event id | SUID | response | global-readback-end | unsafe | safe-final | admission | header |
| ---: | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `01a07050-7382-71c2-9336-33efc7cf3afb` | `063924187516531000000020500422` | 2122 | 1788590733180 | 116763 | 241966 | 1788590716737–1788590717037 / 300 / unknown | unknown |
| 2 | `01a07050-a278-70af-a259-82a85374aaf0` | `063924187528466000001633646930` | 1936 | 1788590754219 | 105067 | 230027 | 1788590728679–1788590728979 / 300 / unknown | unknown |
| 3 | `01a07050-d119-7d9c-8bbd-7088e8ae448e` | `063924187540532000001226437948` | 2091 | 1788590774527 | 93259 | 217935 | 1788590740761–1788590741061 / 300 / unknown | unknown |
| 4 | `01a07050-fff7-70d8-a64d-886f08cf5177` | `063924187552420000001042767609` | 1860 | 1788590784122 | 81927 | 206074 | 1788590752636–1788590752936 / 300 / unknown | unknown |
| 5 | `01a07051-3212-7b1e-9e44-3ba35b3dd425` | `063924187565345000000082008897` | 2935 | 1788590797080 | 69275 | 193137 | 1788590765558–1788590765858 / 300 / unknown | unknown |
| 6 | `01a07051-61b9-7dcf-86e6-f8400590933b` | `063924187577517000001581879577` | 2163 | 1788590816391 | 57402 | 180973 | 1788590777736–1788590778036 / 300 / unknown | unknown |
| 7 | `01a07051-9134-757f-8fb7-f1f7d2c8dcf9` | `063924187589746000001994333525` | 2252 | 1788590841186 | 52142 | 168718 | 1788590789967–1788590790267 / 300 / unknown | unknown |
| 8 | `01a07051-c18c-7c32-9053-023f15ba2fd8` | `063924187601942000001466520243` | 2160 | 1788590844906 | 45784 | 156556 | 1788590802147–1788590802447 / 300 / unknown | unknown |
| 9 | `01a07051-f158-7e87-a6e5-b2b114fc55df` | `063924187614199000001340011423` | 2245 | 1788590844990 | 33855 | 144309 | 1788590814414–1788590814714 / 300 / unknown | unknown |
| 10 | `01a07052-2062-7f95-a9b3-b7ccef8f102a` | `063924187626366000000264870134` | 2162 | 1788590854054 | 26936 | 132145 | 1788590826588–1788590826888 / 300 / unknown | unknown |

### Durable hop and sub-hop distributions

These are reservation-partition rows for the two ten-sample cohorts. The
public-read interval uses the raw harness first-visibility clock; the ledger
first-unsafe-read row is retained in the analysis but is not substituted for
that public observation.

| observed interval | baseline n / p50 / p95 ms | exact-source n / p50 / p95 ms |
| --- | ---: | ---: |
| command receipt → tag append | 10 / 879 / 1020 | 10 / 959 / 1051 |
| tag append → outbox obligation | 10 / 0 / 0 | 10 / 0 / 0 |
| outbox obligation → Queue send returned | 10 / 1149 / 1224 | 10 / 1099 / 1204 |
| Queue send returned → consumer start | 10 / 2199 / 4361 | 10 / 28518 / 46357 |
| consumer start → recordDelivery committed | 10 / 834 / 1137 | 10 / 1650 / 3531 |
| recordDelivery → first public unsafe read | 10 / 890 / 110704 | 10 / 19157 / 100854 |
| recordDelivery → readback start | 10 / 0 / 0 | 10 / 0 / 0 |
| post-record-delivery readback duration | 10 / 111 / 138 | 10 / 236 / 335 |
| source acknowledgement duration | 10 / 136 / 336 | 10 / 229 / 451 |
| completeness coverage duration | 10 / 118 / 279 | 10 / 184 / 633 |
| detector duration | 1 / 355 / 355 (9 missing) | 10 / 985 / 1317 |
| RoomProjector unsafe apply | 10 / 254 / 486 | 10 / 147 / 736 |
| ReservationProjector unsafe apply | 10 / 187 / 372 | 10 / 66 / 658 |
| RoomProjector inline unsafe writer | 10 / 36 / 79 | 10 / 56 / 294 |
| ReservationProjector inline unsafe writer | 10 / 32 / 86 | 10 / 40 / 50 |

The exact-source failures are therefore attributed to the Queue send→consumer
start interval first (p50 28,518 ms, p95 46,357 ms), with the residual
recordDelivery→public-read interval also large (p50 19,157 ms, p95 100,854
ms). The inline unsafe-writer spans are small and every observed completeness
row remains fail-closed (`BLOCK/UNSETTLED` 8/10 and `SETTLED` 2/10); no safe
fence was bypassed. This W130 evidence does not claim that F1/F3/F4 made the
5,000 ms contract pass.

### Real present-binding D1 failure and recovery

The failure proof did not omit the D1 binding. It deployed the exact source
with the existing MV database `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` bound as
the D1 source, so the runtime D1 schema probe/derived source-partition path
failed against a real present binding. Version `b9c58a3e-02f2-4a7a-83e4-c0f193932723`,
deployment `c265df4d-7d7e-43b4-99fd-42e6db044b3e`, and its exact failure
configuration are retained. The public commit returned HTTP 200 committed in
2,074 ms with `not-admitted`; its reservation event was
`01a07057-79f5-7ac6-92de-bb63421d6471`, SUID
`063924187976813000002048063354`, and it was absent from the fully paged
5,000 ms public read. The V1 body still contained no admission field. The
failure binding did not contain the admission telemetry table, so that
variant has no admission row; this is recorded as an observability gap, not a
missing commit or an inferred admission result.

The normal D1 binding was then restored at exact source version
`f7d3f08e-c56c-4b5c-b14a-8afe931cc2a9`. After restoration, the same
reservation became visible at 108,105 ms from the original commit response.
The read-only MV provenance query found exactly one `RoomProjector`
`mv_unsafe_receipts` row with `no-change`, zero `mv_unsafe_rows`, and one
`ReservationProjector` `mv_rows` row for the reservation SUID. The global
receipt query retained one reservation obligation (plus its room obligations),
and no duplicate/regressing unsafe row was observed. The result proves durable
acceptance and eventual Queue/outbox recovery for this present-binding schema
failure; it does not claim a network outage or a safe-head acceptance during
the injected failure.

### V1 body and header evidence

The local real SQLite/public tests and `test:g65` guard prove the three header
outcomes (`admitted`, `not-admitted`, `unknown`) without adding a body field and
prove the response body byte contract. In the deployed W130 healthy cohorts,
all 20 responses had `header=unknown` and zero bodies had an admission field.
The failure variant had a committed `not-admitted` response. No deployed
`admitted` sample occurred in this bounded run; it remains covered by the
local real-path oracle rather than being fabricated from the remote data.

### Lossless receipt storage

The large public cohort receipts are retained as gzip-compressed lossless
artifacts; each was verified with `gzip -dc <artifact>.gz | cmp - <expanded>`.
The compressed SHA-256 values are:

| artifact | SHA-256 |
| --- | --- |
| `.artifacts/sdt-g65-w130-pre-deploy-baseline.json.gz` | `ecd29335f1f027e0f2b1d7eec0726b4a910fe052734121a718a39e402398567e` |
| `.artifacts/sdt-g65-w130-post-deploy-healthy.json.gz` | `690c35a39ee361a79bbfab7b78c777c6aa708d50181d6dcb9e698d4d292d4079` |
| `.artifacts/sdt-g65-w130-d1-schema-failure-cohort.json.gz` | `8bf1ca3c1ece3fe23d3b4fef61ac23fea9c2e00e0c467dcc7d99a676f50a87f2` |
| `.artifacts/sdt-g65-w130-d1-recovery-followup.json.gz` | `19754178a641fa84d8d67d582d39afdbcd959db8dba07c4ff4c5cf8a20cf7dbd` |

For example, decompression is:
`gzip -dc .artifacts/sdt-g65-w130-post-deploy-healthy.json.gz > .artifacts/sdt-g65-w130-post-deploy-healthy.json`.
The compact observed-clock analysis is
`.artifacts/sdt-g65-w130-analysis.json`; all raw request/page receipts remain
available in the compressed files.

### W130 gate boundary

The exact local source remained unchanged during deployment evidence. The
focused `npm run test:g65` and `npm run test:g60:required` reruns passed,
including red-before-green and all six unchanged G60 mutants. `npm run
typecheck`, `npm run lint`, and `git diff --check` passed; the broader G26,
G29, G41, G44, G49, G51, G52, G53, G54, G55, G58, G61, and G62 results remain
the exact-head local results recorded above. No PR state transition, self-review,
merge, or worker completion was performed. W130 ends as an evidence checkpoint
for PR #127 with the 5,000 ms and all safe-lane/fence/Queue/V1 boundaries
unchanged.

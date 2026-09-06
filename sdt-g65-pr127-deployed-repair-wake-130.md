# SDT-G65 PR #127 deployed repair evidence — WAKE-130

Task: `SDT-G65-PR127-DEPLOYED-REPAIR-WAKE-130`

Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)

PR: [#127](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/127)

Branch: `claude/sdt-g65-local-wake-w128`

Product source under test: `557aa1b1b78328866538f3c3fb56d3d529996994`
Scope: deployed F1/F3/F4 evidence only; no self-review, merge, or worker-complete transition.

## Result

The authorized existing-arm measurement completed and the evidence checkpoint
is pushed to PR #127. The exact-source healthy cohort was not an acceptance
pass: all 10 samples exceeded the unchanged 5,000 ms unsafe-visibility bound
and none met the 180-second safe proof. The durable evidence names the first
dominant observed interval as Queue send returned → consumer invocation start
(p50 28,518 ms, p95 46,357 ms); completed inline unsafe-writer spans remained
short. This continuation therefore reports the misses without tuning or a
second cohort.

## Deployment and credential boundary

Only the existing throwaway arm was used:

- Worker: `sekiban-dcb-g60-w155-c`
- Pipeline D1: `ac751211-fde8-4587-9d56-1e9fd8051bc3`
- MV D1: `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`
- Queue/DLQ: `sekiban-dcb-g60-w155-c-outbox` /
  `sekiban-dcb-g60-w155-c-outbox-dlq`
- Config: `.artifacts/wrangler.g65-w155-c.jsonc`

No resource or migration operation was performed. Every Wrangler receipt was
run through the stripped wrapper with all five recognized credential variable
names `UNSET` and `noKeepVars=true`; no secret value was printed or logged.
Conformance was path-only. No authorization failure occurred, so the
WAKE-122 retry/classifier rule was not invoked.

The pre-deploy arm was version `2b1dae1e-5b3d-4c48-8e64-67a8cf64b850`,
deployment `d1b85541-6339-4f41-a3ae-10f0f260264b`, annotation
`SDT-G65 W129 restore normal D1 exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`,
100%. The exact deployment was version
`443416d2-204e-442a-af96-3400532bdcf6`, deployment
`acff763a-7346-4fb5-af7d-e49fba5c647c`, annotation
`SDT-G65 W130 exact 557aa1b1b78328866538f3c3fb56d3d529996994`, 100%.
After the failure proof, normal D1 was restored at version
`f7d3f08e-c56c-4b5c-b14a-8afe931cc2a9`, deployment
`be0bf5d9-51f6-4c1f-9d17-f9b17eeecf53`, 100%, with the exact same source
annotation.

Receipts:

- `.artifacts/sdt-g65-w130-pre-versions.json`
- `.artifacts/sdt-g65-w130-pre-deployments.json`
- `.artifacts/sdt-g65-w130-deploy.json`
- `.artifacts/sdt-g65-w130-post-versions.json`
- `.artifacts/sdt-g65-w130-post-deployments.json`
- `.artifacts/sdt-g65-w130-restore-versions.json`
- `.artifacts/sdt-g65-w130-restore-deployments.json`

## Clock and interpretation rules

The tables use only observed harness fetch/response clocks and durable
W125/W127 `Date.now()` epoch-millisecond boundaries. They do not use authored
`dcb_events.Timestamp`, caller `received_at`, or
`serialized_dcb_global_receipts.received_at` as a completion/visibility clock.
The persisted post-record-delivery global-receipt readback is an observed
operational read, not a proof that `global_completion_observed_at` was set.
Its persistence can lag a public read; no causal ordering is inferred from
that observer lag.

`safe-final` is commit-response to the final projector/tag-state proof, not an
invented public safe-read timestamp. Both cohorts eventually reached their
final projector SUIDs and all 11 cohort tag-state reads returned committed
version 1, but neither cohort met the 180-second bound.

## Cohort summary

| arm | run ID | n | response p50/p95 | commit → ledger readback end p50/p95 | commit → first public unsafe p50/p95 | over 5,000 ms | safe-final p50/p95 | within 180 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| pre-deploy `ccfa0b0` | `ddaefd4d-c24d-40b7-810d-7a0d9c20f5d4` | 10 | 2,063 / 2,429 ms | 3,855 / 6,037 ms | 4,548 / 116,615 ms | 3/10 | 141,066 / 202,629 ms | no |
| exact `557aa1b` | `39bb238c-503c-4aef-8a83-99a0d3039a87` | 10 | 2,160 / 2,935 ms | 31,111 / 50,819 ms | 57,402 / 116,763 ms | 10/10 | 180,973 / 241,966 ms | no |

The baseline final heads were both
`063924187134766000002028023507`; the exact-source final heads were both
`063924187626366000000264870134`. Sampled health snapshots reported
`SETTLED`; durable per-event completeness rows are retained and include
`BLOCK/UNSETTLED`.

## Every sample

The `global-readback-end` column is an observed absolute epoch-millisecond
ledger boundary. `admission` is the reservation-partition attempt's exact
start–end epoch milliseconds, duration, and outcome. All 20 healthy cohort
attempts were 300 ms and `unknown`; all had null
`global_completion_observed_at`. `unsafe` is the raw public list first-visible
elapsed time from the commit response. `header` is the caller-visible
`x-sdt-global-admission`; no valid V1 body contained an admission member.

### Pre-deploy baseline

| # | event ID | SUID | response | global-readback-end | unsafe | safe-final | admission | header |
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

### Exact-source healthy cohort

| # | event ID | SUID | response | global-readback-end | unsafe | safe-final | admission | header |
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

## Hop tables and diagnosis

| interval | baseline n / p50 / p95 ms | exact-source n / p50 / p95 ms |
| --- | ---: | ---: |
| command receipt → tag append | 10 / 879 / 1020 | 10 / 959 / 1051 |
| tag append → outbox | 10 / 0 / 0 | 10 / 0 / 0 |
| outbox → Queue send returned | 10 / 1149 / 1224 | 10 / 1099 / 1204 |
| Queue send returned → consumer start | 10 / 2199 / 4361 | 10 / 28518 / 46357 |
| consumer start → recordDelivery | 10 / 834 / 1137 | 10 / 1650 / 3531 |
| recordDelivery → first public unsafe read | 10 / 890 / 110704 | 10 / 19157 / 100854 |
| recordDelivery → readback start | 10 / 0 / 0 | 10 / 0 / 0 |
| readback duration | 10 / 111 / 138 | 10 / 236 / 335 |
| source acknowledgement | 10 / 136 / 336 | 10 / 229 / 451 |
| completeness coverage | 10 / 118 / 279 | 10 / 184 / 633 |
| detector | 1 / 355 / 355 (9 missing) | 10 / 985 / 1317 |
| RoomProjector unsafe apply | 10 / 254 / 486 | 10 / 147 / 736 |
| ReservationProjector unsafe apply | 10 / 187 / 372 | 10 / 66 / 658 |
| RoomProjector inline writer | 10 / 36 / 79 | 10 / 56 / 294 |
| ReservationProjector inline writer | 10 / 32 / 86 | 10 / 40 / 50 |

The exact-source data first points to Queue send→consumer start as the
dominant interval. The inline unsafe writer and all completed post-admission
spans are short relative to the misses. Exact-source completeness outcomes
were `BLOCK/UNSETTLED` 8/10 and `SETTLED` 2/10; the independent unsafe apply
therefore did not bypass the safe fence. The durable writer boundaries show
the direct unsafe path executing while the completeness result is BLOCK, and
the later Queue path produces applied/no-change or duplicate-race outcomes
without a double-apply/regression.

The full compact observed-clock analysis is
[`.artifacts/sdt-g65-w130-analysis.json`](.artifacts/sdt-g65-w130-analysis.json);
the raw ledger queries are
`.artifacts/sdt-g65-w130-pre-ledger.json`,
`.artifacts/sdt-g65-w130-post-ledger.json`,
`.artifacts/sdt-g65-w130-d1-recovery-ledger.json`, and
`.artifacts/sdt-g65-w130-d1-recovery-mv.json`.

## Present-binding D1 failure and recovery

This was not an absent-binding shortcut. The temporary failure config bound
the existing MV D1 `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` as the runtime D1
source. The exact source deployed as version
`b9c58a3e-02f2-4a7a-83e4-c0f193932723`, deployment
`c265df4d-7d7e-43b4-99fd-42e6db044b3e`, 100%. A real public SQLite commit
returned HTTP 200 committed in 2,074 ms with `not-admitted`; its reservation
was absent from the fully paged 5,000 ms public read. This proves durable
acceptance did not wait for the derived D1 source-partition operation. The
failure binding lacked the admission telemetry table, so its admission row is
explicitly missing rather than inferred.

Normal D1 was restored at exact source version
`f7d3f08e-c56c-4b5c-b14a-8afe931cc2a9`. The same reservation became public
visible after restoration at 108,105 ms from the original commit response.
The MV provenance receipt has exactly one `RoomProjector`
`mv_unsafe_receipts` row with `no-change`, zero `mv_unsafe_rows`, and one
`ReservationProjector` `mv_rows` row. The global receipts contain one
reservation obligation plus its room obligations; no duplicate/regressing row
was observed. This is a present-binding schema-failure/recovery proof, not a
claim of a network outage; local real SQLite tests cover unavailable and
never-resolving derived-write cases.

## V1 body/header and local guard evidence

The local real SQLite/public tests and `npm run test:g65` prove the admitted,
not-admitted, and unknown header outcomes while asserting that the valid V1
JSON body has no admission field. Remote W130 healthy samples were `unknown`
10/10 before and 10/10 after; the failure sample was committed
`not-admitted`. No remote admitted sample occurred, so the admitted case is
not fabricated from deployed data. The six inherited G60 mutants remained
unchanged and red-capable.

## Lossless artifacts and verification

The expanded public receipts are preserved locally; committed durable copies
are gzip-compressed and byte-verified with
`gzip -dc <artifact>.json.gz | cmp - <artifact>.json`.

| compressed raw receipt | SHA-256 |
| --- | --- |
| `.artifacts/sdt-g65-w130-pre-deploy-baseline.json.gz` | `ecd29335f1f027e0f2b1d7eec0726b4a910fe052734121a718a39e402398567e` |
| `.artifacts/sdt-g65-w130-post-deploy-healthy.json.gz` | `690c35a39ee361a79bbfab7b78c777c6aa708d50181d6dcb9e698d4d292d4079` |
| `.artifacts/sdt-g65-w130-d1-schema-failure-cohort.json.gz` | `8bf1ca3c1ece3fe23d3b4fef61ac23fea9c2e00e0c467dcc7d99a676f50a87f2` |
| `.artifacts/sdt-g65-w130-d1-recovery-followup.json.gz` | `19754178a641fa84d8d67d582d39afdbcd959db8dba07c4ff4c5cf8a20cf7dbd` |

Decompression example:
`gzip -dc .artifacts/sdt-g65-w130-post-deploy-healthy.json.gz > .artifacts/sdt-g65-w130-post-deploy-healthy.json`.

## Gates and boundary

The focused `npm run test:g65` rerun passed (8/8 plus green guard and six
red mutants). `npm run test:g60:required` passed with direct-doorbell,
Queue-latency, durable-hop, unsafe-writer, and post-admission guards green;
their red-before-green/mutant receipts remain preserved. `npm run typecheck`,
`npm run lint`, and `git diff --check` passed. The broader G26/G29/G41/G44/G49/
G51/G52/G53/G54/G55/G58/G61/G62 local results remain the exact-head results
recorded in the W129/W130 local evidence; no gate, timeout, V1 body, 5,000 ms
contract, Queue/outbox/global-admission ordering, safe fence, G58, or G62
behavior was changed.

This task ends at the pushed evidence checkpoint for reviewer rereview. It
does not claim SDT-G65 acceptance, open/merge PR #127, or perform worker
completion.

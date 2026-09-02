# SDT-G52 post-G41 commit breakdown — interim W75

Status: **source-separated partial evidence**. This is the same coherent W71 paced cohort, not a new cohort. W75 made no deployment and sent no application request. It records exactly one further read-only resume of its immutable 51-ray ledger.

## Cohort and ownership calibration

The paced cohort remains one discarded accepted warm-up plus 50 accepted sequential `POST /api/commands/create-room` samples on Cloudflare version `38921aad-9faf-4ac5-bdfd-1348d7214422`, source `6db728122fefc410e7d9639d62302bb107df13be`. The persisted state at `.artifacts/sdt-g52-w69-paced-resume.json` retains the exact 51-ray ledger and cohort window `2026-09-02T10:27:13.077Z`–`2026-09-02T10:36:33.731Z`.

The Worker snapshot is a Worker-owned root, not a reconstructed whole-system trace. Its strict required-row set now excludes the Durable Object-owned rows `S07`, `S09`, `S12`, `S14`, and `S16`. `S07`, `S12`, and `S14` are TagDurableObject member operations; `S09` is allocator work; `S16` is a remote actor callback. This is a G52 snapshot-ownership calibration only: the authority manifest and native-trace gates remain unchanged. Every remaining Worker-owned success row remains fail-closed.

The active latency table continues to mark S04/S05 structurally absent under G41/G47. That reporting rule is distinct from the snapshot's raw success-inventory validation and does not convert either source into a latency claim.

DO-owned rows are sourced only from retained `sdt.observe/v1` `do.handler` observations grouped by `actorClass`. The W75 response retained none for this exact cohort, so those rows are stated as `n=0`, not inferred from the Worker snapshot.

## W75 read result

The one W75 `--mode resume` invocation ran at `2026-09-02T15:02:18.190Z`, using normal script/type filters over the persisted window and client-side intersection with the immutable rays. It made no deployment or app request and was not retried.

- Retained snapshot invocation roots: **1 / 51**.
- Retained schema-complete accepted sample roots: **1 / 50**; 49 measured requests remain absent.
- First observed schema-complete-root lag: **16,241,210 ms**.
- Retained `do.handler` observations for the full 51-request cohort: **0**.

The state remains `awaiting-resume-query` for a later separately authorized same-cohort read; W75 itself performed exactly this one read.

## Interim timing and per-hop table

Every row identifies its source and its sample count. The Worker medians are descriptive singleton values (`n=1`), not a population estimate. `unavailable` is not zero.

| Hop / measurement | Source | n | Descriptive result |
| --- | --- | ---: | --- |
| S00 client timing | W71 immutable client ledger, LAX | 50 | nearest-rank p50 1,308 ms; p95 2,113 ms |
| S00 | retained Worker snapshot-log root | 1 | median 520 ms |
| S01 | retained Worker snapshot-log root | 1 | median 0 ms |
| S02 | retained Worker snapshot-log root | 1 | median 45 ms |
| S03 | retained Worker snapshot-log root | 1 | median 46 ms |
| S04 / S05 | G41/G47 structural rule | n/a | structurally absent from the active latency table |
| S06 | retained Worker snapshot-log root | 1 | median 0 ms |
| S07 reservation member | retained `sdt.observe/v1 do.handler`, expected `TAG` actorClass | 0 | unavailable; not claimed by the Worker snapshot |
| S08 | retained Worker snapshot-log root | 1 | median 64 ms |
| S09 allocator finalize | retained `sdt.observe/v1 do.handler`, expected `ALLOCATOR` actorClass | 0 | unavailable; not claimed by the Worker snapshot |
| S10 | retained Worker snapshot-log root | 1 | median 17 ms |
| S11 | retained Worker snapshot-log root | 1 | median 326 ms |
| S12 append member | retained `sdt.observe/v1 do.handler`, expected `TAG` actorClass | 0 | unavailable; not claimed by the Worker snapshot |
| S13 | retained Worker snapshot-log root | 1 | median 22 ms |
| S14 result-state member | retained `sdt.observe/v1 do.handler`, expected `TAG` actorClass | 0 | unavailable; not claimed by the Worker snapshot |
| S15 | retained Worker snapshot-log root | 1 | median 0 ms |
| S16 remote actor callback | retained `sdt.observe/v1 do.handler`, retained actorClass determines source | 0 | unavailable; not claimed by the Worker snapshot |

| DO actorClass grouping | Source | n | constructor-to-handler median | first-storage-read median | subrequest-wall median |
| --- | --- | ---: | ---: | ---: |
| TAG (S07/S12/S14 source) | retained `sdt.observe/v1 do.handler`, exact cohort intersection | 0 | unavailable | unavailable | unavailable |
| ALLOCATOR (S09 source) | retained `sdt.observe/v1 do.handler`, exact cohort intersection | 0 | unavailable | unavailable | unavailable |
| remote actor class (S16 source) | retained `sdt.observe/v1 do.handler`, exact cohort intersection | 0 | unavailable | unavailable | unavailable |

## Client-data-only residual ranking

The ranking uses only the retained Worker snapshot singleton; it does not rank absent DO work. In descending descriptive median order: S00 520 ms, S11 326 ms, S08 64 ms, S03 46 ms, S02 45 ms, S13 22 ms, S10 17 ms, then S01/S06/S15 at 0 ms (all `n=1`). It is an interim source-labelled ordering, not an attribution of the client p95 or a complete commit-path conclusion.

## R-3 — public Worker fetch retention limitation

The authoritative retention evidence remains: burst snapshot roots **2 / 51** (870 retained spans), paced snapshot roots **1 / 51** (451 retained spans), and waitUntil-free public GET roots **0 / 10**. W75 independently re-observed the paced cohort at **1 / 51** retained snapshot roots and **1 / 50** schema-complete measured roots. Public Worker fetch invocations for this script are not retained at a useful cohort rate regardless of `waitUntil`, while scanner traffic is retained. The 40-root target remains unreachable under this platform behaviour; this is R-3 retention evidence, not a reason to fabricate absent per-hop or DO data.

## Verification and CI record

`npm run test:g52` passed: typecheck, 18 focused tests, snapshot sink/mapped-row omission mutants red, the new Worker-only snapshot fixture, and the resume ownership fixture that still rejects a missing Worker row. `node scripts/g30-trace-mutation-runner.mjs --self-test` recognizes the new `snapshot-do-ownership-split-gate` alongside the existing mutation matrix.

The prior `ci-foundation` failure on `7271e28` contained pre-existing unrelated full-suite failures, including the G43 5,000 ms timeout in `test/g43-tag-sql.spec.ts`. W75 triggers exactly one replacement `ci-foundation` execution on the repaired head; its final status is recorded in the W75 report without changing G43.

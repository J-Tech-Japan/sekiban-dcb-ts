# SDT-G52 post-G41 commit breakdown — interim W73

Status: **blocked interim evidence**. This is the same coherent W71 paced cohort; W73 sent no application request and did not deploy. It records the one authorized W73 resume read and does not turn an unvalidated retained log into a latency conclusion.

## Cohort and identity discipline

The paced cohort remains one discarded accepted warm-up plus 50 accepted sequential `POST /api/commands/create-room` samples on Cloudflare version `38921aad-9faf-4ac5-bdfd-1348d7214422`, source `6db728122fefc410e7d9639d62302bb107df13be`. Its immutable state at `.artifacts/sdt-g52-w69-paced-resume.json` has 51 exact CF-Ray values and the persisted window `2026-09-02T10:27:13.077Z`–`2026-09-02T10:36:33.731Z`.

W73 made exactly one `--mode resume` invocation at `2026-09-02T12:43:09.513Z`. It used the normal script/type filters over that persisted window and intersected results client-side with the saved rays. It made no deployment and no app-surface request.

The exporter repair makes the retained snapshot's `platformRequestId` the primary client-ledger join. A retained top-level `correlationId` is accepted only when it equals the full S00 `correlation.id`, or is a prefix of at least 32 characters of that full value. Root bounds, root cardinality, service identity, provider-ray agreement, manifest-row checks, and all other identity checks remain fail-closed. The local fixture also covers a provider representation that nests the dotted S00 identity inside the retained row; it does not manufacture an identity.

## W73 read result

The one W73 read reached the repaired windowed query and then stopped at this exact integrity error:

```
g30-trace-export:snapshot-log:snapshot S00 correlation.id must be a non-empty string
```

No retry was made. The state records `resume-query-error`, attempt 3, and the next scheduled eligibility at `2026-09-02T12:58:09.513Z`; the cohort bound remains `2026-09-03T10:19:00.000Z`. The post-read local representation adapter is covered by tests but was added after this one permitted read, so this document does not claim it was live-validated.

## Interim timing and per-hop table

Every row names its source and sample count. `unavailable` is deliberately not zero: the query returned a candidate root, but its full S00 identity did not pass the required validator, so no valid snapshot-root count or median can be reported.

| Hop / measurement | Source | n | Descriptive result |
| --- | --- | ---: | --- |
| S00 client timing | W71 immutable client ledger, LAX | 50 | nearest-rank p50 1,308 ms; p95 2,113 ms |
| S00 snapshot row | retained snapshot-log root | unavailable | blocked before validated root construction |
| S01 bootstrap admit | retained snapshot-log root | unavailable | blocked before validated root construction |
| S02 bootstrap release | retained snapshot-log root | unavailable | blocked before validated root construction |
| S03 reservation stage | retained snapshot-log root | unavailable | blocked before validated root construction |
| S04 / S05 | G41/G47 structural rule | n/a | structurally absent, not an unobserved retained row |
| S06 reservation member | retained snapshot-log root | unavailable | blocked before validated root construction |
| S07 allocator | retained snapshot-log root | unavailable | blocked before validated root construction |
| S08 final fence | retained snapshot-log root | unavailable | blocked before validated root construction |
| S10 tag append stage | retained snapshot-log root | unavailable | blocked before validated root construction |
| S11 tag append member | retained snapshot-log root | unavailable | blocked before validated root construction |
| S12 result-state stage | retained snapshot-log root | unavailable | blocked before validated root construction |
| S13 result-state member | retained snapshot-log root | unavailable | blocked before validated root construction |
| S14 response build | retained snapshot-log root | unavailable | blocked before validated root construction |
| S15 response completion | retained snapshot-log root | unavailable | blocked before validated root construction |

| DO actorClass | Source | n | constructor-to-handler median | first-storage-read median | subrequest-wall median |
| --- | --- | ---: | ---: | ---: |
| no validated actor-class row | whole-cohort `sdt.observe/v1` `do.handler` window result | unavailable | unavailable | unavailable | unavailable |

## Residual ranking

No residual ranking is derived from this interim table. The only valid timing population is the client S00 ledger; assigning it to an individual commit hop, or ranking a snapshot row that failed identity validation, would fabricate AC5 evidence. The next authorized same-cohort read may update this table and ranking on the same branch/PR only after the retained S00 identity validates.

## R-3 — public Worker fetch retention limitation

The authoritative direct Observability observations are retained here as platform evidence: the burst cohort retained **2 / 51** snapshot roots (870 retained spans), the paced cohort retained **1 / 51** snapshot root (451 retained spans), and the waitUntil-free public GET probe retained **0 / 10**. The broadened finding is that public Worker fetch invocations for this script are not retained regardless of `waitUntil`, while scanner invocations are retained. Thus the 40-root threshold is unreachable under the observed platform behaviour; this is an R-3 log-retention follow-up, not a hop-latency conclusion.

## Verification recorded with this checkpoint

`npm run test:g52` passed after the exporter repair: typecheck, 17 focused G52 tests, and the existing sink/mapped-row omission mutants both red in their self-test. The new fixture proves the permitted 32-character prefix, `platformRequestId` client join without an envelope ray, and rejection of shorter or nonmatching prefixes.

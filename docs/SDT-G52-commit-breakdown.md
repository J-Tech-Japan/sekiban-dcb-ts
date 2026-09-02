# SDT-G52 post-G41 commit breakdown — interim W74

Status: **partial interim evidence; PR is not blocked on snapshot-log rows alone**. This is the same coherent W71 paced cohort. W74 sent no application request and did not deploy. It records the one authorized W74 resume read and does not turn an unvalidated retained log into a latency conclusion.

## Cohort and identity discipline

The paced cohort remains one discarded accepted warm-up plus 50 accepted sequential `POST /api/commands/create-room` samples on Cloudflare version `38921aad-9faf-4ac5-bdfd-1348d7214422`, source `6db728122fefc410e7d9639d62302bb107df13be`. Its immutable state at `.artifacts/sdt-g52-w69-paced-resume.json` has 51 exact CF-Ray values and the persisted window `2026-09-02T10:27:13.077Z`–`2026-09-02T10:36:33.731Z`.

W74 made exactly one `--mode resume` invocation at `2026-09-02T13:56:09.512Z`. It used the normal script/type filters over that persisted window and intersected results client-side with the saved rays. It made no deployment and no app-surface request. Its persisted state records attempt 4, `resume-query-error`, and the next scheduled eligibility at `2026-09-02T14:11:09.512Z`; the cohort bound remains `2026-09-03T10:19:00.000Z`.

The exporter makes the retained snapshot's `platformRequestId` the primary client-ledger join. A retained top-level `correlationId` is accepted only when it equals the full S00 `correlation.id`, or is a prefix of at least 32 characters of that full value. Root bounds, root cardinality, service identity, provider-ray agreement, manifest-row checks, and all other identity checks remain fail-closed. The focused fixture covers the retained row shape `correlation:{id}`, `service:{id}`, and `schema:{version}`, together with the permitted 32-character prefix and an envelope-ray-free `platformRequestId` join. It also retains the rejection cases for short and nonmatching prefixes.

## W74 read result

The one W74 read reached the repaired windowed query and then stopped at this exact integrity error:

```
g30-trace-export:snapshot-log:snapshot log is missing mapped success row(s) S07
```

No retry was made. This is live evidence that the returned candidate progressed past the prior S00 `correlation.id` rejection and reached the strict required-row check. It does not establish that every retained candidate has all three nested fields, nor does it relax the required `S07` allocator row. The raw provider response is intentionally not persisted after a failed normalizer pass, so `S07` is the exact rejecting field available for this W74 artifact.

## Interim timing and per-hop table

Every row names its source and sample count. `unavailable` is deliberately not zero: the query returned a candidate root, but its full S00 identity did not pass the required validator, so no valid snapshot-root count or median can be reported.

| Hop / measurement | Source | n | Descriptive result |
| --- | --- | ---: | --- |
| S00 client timing | W71 immutable client ledger, LAX | 50 | nearest-rank p50 1,308 ms; p95 2,113 ms |
| S00 snapshot row | retained snapshot-log root | unavailable | candidate reached the strict `S07` completeness check; no validated root was emitted |
| S01 bootstrap admit | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S02 bootstrap release | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S03 reservation stage | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S04 / S05 | G41/G47 structural rule | n/a | structurally absent, not an unobserved retained row |
| S06 reservation member | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S07 allocator | retained snapshot-log root | unavailable | exact W74 rejecting field: required mapped success row absent |
| S08 final fence | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S10 tag append stage | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S11 tag append member | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S12 result-state stage | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S13 result-state member | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S14 response build | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |
| S15 response completion | retained snapshot-log root | unavailable | candidate rejected before a complete validated root was emitted |

| DO actorClass | Source | n | constructor-to-handler median | first-storage-read median | subrequest-wall median |
| --- | --- | ---: | ---: | ---: |
| no validated actor-class row | whole-cohort `sdt.observe/v1` `do.handler` window result | unavailable | unavailable | unavailable | unavailable |

The one allowed W74 resume did not persist a valid provider response after its snapshot-normalizer error. Therefore no whole-cohort `do.handler` actor-class population or median is available to copy honestly into this checkpoint. The PR carries the valid client S00 result and this explicitly unavailable DO observation, rather than blocking on unavailable snapshot rows or fabricating a median.

## Residual ranking

No residual ranking is derived from this interim table. The only valid timing population is the client S00 ledger; assigning it to an individual commit hop, or ranking a snapshot row rejected for missing `S07`, would fabricate AC5 evidence. A future authorized same-cohort read may update this table and ranking on the same branch/PR only after a complete retained snapshot validates.

## R-3 — public Worker fetch retention limitation

The authoritative direct Observability observations are retained here as platform evidence: the burst cohort retained **2 / 51** snapshot roots (870 retained spans), the paced cohort retained **1 / 51** snapshot root (451 retained spans), and the waitUntil-free public GET probe retained **0 / 10**. The broadened finding is that public Worker fetch invocations for this script are not retained regardless of `waitUntil`, while scanner invocations are retained. Thus the 40-root threshold is unreachable under the observed platform behaviour; this is an R-3 log-retention follow-up, not a hop-latency conclusion.

## Verification recorded with this checkpoint

`npm run test:g52` passed: typecheck, 17 focused G52 tests, and the existing sink/mapped-row omission mutants both red in their self-test. The new fixture proves the permitted 32-character prefix, `platformRequestId` client join without an envelope ray, nested `correlation`/`service`/`schema` row attributes, and rejection of shorter or nonmatching prefixes. The full `node scripts/g30-trace-mutation-runner.mjs` suite also passed, including the original and snapshot-specific platform-ray/client-join gates.

The pre-repair `ci-g30-core` failure was deterministic: its mutation runner found two instances of the old platform-ray join anchor after the snapshot join was introduced. The repaired runner distinguishes the native-root and snapshot anchors and passed locally. The contemporaneous `ci-g43` failure is an unrelated existing 5,000 ms timeout in `test/g43-tag-sql.spec.ts`; no G43 test, timeout, or gate was changed here.

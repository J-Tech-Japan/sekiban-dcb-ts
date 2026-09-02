# SDT-G52 post-G41 commit breakdown — interim W72

Status: **blocked interim evidence**. This document preserves the coherent W71 paced cohort and the one W72 resume attempt. It does not present an unvalidated per-hop table as AC4/AC5 evidence.

## Deployed cohort and query discipline

The paced cohort remains the only fallback cohort: one discarded accepted warm-up and 50 accepted `POST /api/commands/create-room` samples on Cloudflare version `38921aad-9faf-4ac5-bdfd-1348d7214422` from source `6db728122fefc410e7d9639d62302bb107df13be`. Its immutable ledger contains 51 CF-Ray values. W72 sent no app request and no deployment.

W71's direct exact-ray exporter chain returned HTTP 400. W72 replaced that shape with two bounded, read-only Workers Observability requests over the immutable paced window (`2026-09-02T10:27:13.077Z`–`2026-09-02T10:36:33.731Z`): one using the normal script scope plus the `sdt.commit-snapshot/v1` / `commit.snapshot` type filters, and one using the normal script scope plus `sdt.observe/v1`. The exporter then intersects returned records with the saved client rays; it neither widens the cohort nor uses time-nearest matching. Local tests prove this query shape has no `$metadata.rayId` filter and preserves the exact client-side intersection.

The sole W72 `--mode resume` invocation reached the snapshot normalizer and stopped at this exact integrity error:

```
g30-trace-export:snapshot-log:snapshot S00 does not agree with its top-level identity
```

No retry was made. The raw provider response was not persisted after that failure, so the following table is intentionally an availability record, not fabricated evidence.

## Interim timing table

| Measurement | Source | n | Result |
| --- | --- | ---: | --- |
| S00 client nearest-rank p50 | W71 immutable client ledger | 50 | 1,308 ms |
| S00 client nearest-rank p95 | W71 immutable client ledger | 50 | 2,113 ms |
| Caller colo | W71 immutable client ledger | 50 | LAX: 50 |
| S00, S01, S02, S03, S06, S07, S08, S10, S11, S12, S13, S14, S15 | retained snapshot-log root | unavailable | Not published: the returned root failed the S00/top-level identity invariant before a validated row table could be formed. |
| S04 and S05 | structural rule | n/a | Structurally absent after G41/G47; not a missing observed row. |
| `sdt.observe/v1` `do.handler` constructor-to-handler, first storage read, subrequest wall by `actorClass` | whole persisted cohort | unavailable | Not published: the failure path deliberately retains no unvalidated observation payload or median. |

Consequently, no residual ranking is derived from this table. Ranking an unvalidated snapshot would turn an observation integrity failure into a latency conclusion, which this unit must not do.

## R-3 — retention limitation

The authoritative third AC4 amendment records the direct Observability counts for the two coherent windows: the burst cohort retained **2 / 51** snapshot roots with **870** retained spans, while the paced cohort retained **1 / 51** snapshot roots with **451** retained spans. These source counts are attributed to that direct amendment observation; W72 did not independently recompute them after the snapshot validator stopped.

Under this observed platform behaviour, the 40-root threshold is unreachable. The working hypothesis for follow-up is that Worker fetch invocations with long `ctx.waitUntil` autoDrain work are dropped while Durable Object invocations are retained. This is an R-3 retention finding, not a claim that a particular commit hop is slow.

## What remains

The corrected persisted-window query tooling is committed with its focused guard. A future design-authorized resume may update this same evidence/PR only with the original W71 51-ray state. It must not create a third cohort or stitch new requests. The S00 identity mismatch must be resolved or explicitly classified before AC4/AC5 can be accepted.

# SDT-G42 Journal first-touch evidence

Status at candidate creation: P0 is `PARTIAL`; P1 has not run. This document does not turn a retention-limited P0 audit into new production traffic, and it does not state a Journal sharding, pooling, or scheduler conclusion before P1 has a committed pre-run plan and receipts.

## Scope and advisory boundary

G42 measures a narrow first-touch contrast. It does not implement pooling, sharding, a multi-attempt scheduler, routing version, GC, recovery, or placement. Its eventual three-valued verdict is **ADVISORY**: a positive result may authorize drafting a later C-1 packet, but it is neither a correctness nor performance gate and cannot serve as that later candidate's acceptance evidence. A later candidate must take its own contemporaneous baseline and candidate samples.

## P0: existing G37 A-5 cohort, read-only

The committed machine-readable audit is [`docs/evidence/SDT-G42-p0-audit.json`](evidence/SDT-G42-p0-audit.json). It ran one bounded exact-correlation telemetry query over the final 50-request G37 A-5 repeat cohort and generated no new traffic.

| Fact | Observed value |
| --- | --- |
| Typed outcome | `PARTIAL` |
| Expected G37 cohort identities | 50 |
| Correlation-joined identities | 46 |
| Exact S04/S05 row-mapped identities | 0 |
| Preserved UNKNOWN identities | 4 (`journal-handler-absent`) |
| Journal handler facts in joined groups | 228 |
| `constructorToHandlerMs` | min 0, p50 147, p95 452, max 2687 ms |
| `firstStorageReadMs` | min/p50/p95/max 0 ms |

All 46 correlation groups retained one Journal `activationId`, but existing `do.handler` facts do not retain a row ID. Consequently, whether an individual S04 was `activationFirst`, and whether that particular S04 shares an activation with S05a-d, are both `UNKNOWN` for all 50 identities. The audit does not infer a row from timestamp order or from the number of handler facts in a correlation group.

`constructorToHandlerMs` starts only after the platform has instantiated the JavaScript class. It excludes routing, placement, and pre-construction startup; it is not a platform cold-start timer. `firstStorageReadMs` is captured immediately before the first durable read or transaction begins. It is handler-entry-to-storage-touch, not storage-read latency. Workers Logs retention is provider/config-dependent and short; the audit preserves query availability and all join failures rather than treating absence as a measurement.

## P1 topology and treatment protocol

P1 uses only the exact authenticated primary-component conformance route `POST /conformance/v1/g42/journal-first-touch`, with no query string and `application/json`. The guard chain is: primary-component guard, credential guard, exact method/path/query/content-type/body validation, existing G32 final-cutover fence, and then Journal namespace lookup. The route is absent from the G38 receiver and tombstone files/configs.

The probe deliberately performs authorized synthetic writes in the production JOURNAL namespace so storage behavior is representative. It is not claimed to be unreachable from production ingress. All identities and logical keys have a reserved fixed-length G42 prefix, are re-derived from the pre-run schedule, and use storage keys disjoint from `JOURNAL_KEY`. The probe checks for a normal Journal record and refuses that identity rather than writing it. Each trial has separately timed idempotent cleanup followed by inventory; the checker requires an empty alarm/key inventory for every scheduled identity. An uncleaned probe alarm clears only the reserved marker and never accesses a production recovery port.

The primary contrast is A minus D caller wall time. A creates a fresh record on a fresh reserved physical identity. D creates an alarm-free fixed-size warm-up logical record, then creates the measured record under a distinct logical key in the same physical identity. B (handler-only ping) and C (completed `/state` missing-key read) are diagnostic mediators, not separately named causal components. Every immediate B/C/D measurement must retain the precondition's activation ID and have `activationFirst=false`; violations are `UNKNOWN`. A mismatched or missing caller colo marks the entire balanced block `UNKNOWN`, never a selectively retained member.

For alarm-on writes, the measured transaction records `getAlarm()==null` immediately before the write and exactly one far-future `setAlarm`; alarm-off writes record no alarm set. Request and record byte counts, caller/handler/transaction walls, alarm facts, and cleanup facts are retained in each receipt. D is a **storage-layout screen only**. It does not validate a multi-attempt scheduler, shard count, routing version, concurrency, hot-shard behavior, GC, recovery, or fault blast radius.

The externally timed A/B/C/D envelope always carries the same fixed-width `warmupLogicalKey` field. For D it is the distinct scheduled warm-up key; for A/B/C it repeats `logicalKey` as inert padding and is never sent to JOURNAL. This removes a public JSON-envelope byte-count difference from the A/D caller-wall contrast; the inner measured JOURNAL write remains one fixed shape for every cell.

Idle sensitivity cells request 2 s, 15 s, and 180 s gaps. Their D warm-up finishes before the gap; the post-gap measurement is then classified as observed activation `CONTINUITY`, `RESTART`, or `UNKNOWN`. A fresh reference is collected in the same randomized block/window. Requested idle is never used as a synonym for warm. These reports are sensitivity-only unless a regime independently reaches the AC6 complete-block floor.

## Pre-run decision and reproducibility procedure

Before the first P1 trial, commit a pre-run plan P at `docs/evidence/SDT-G42-pre-run-plan.json`. P records the full schedule, target source commit, config and module-bundle digests, provider version/config identity, decision object, and calculator hash. The runner starts only with a clean tree where `HEAD == P`, records P/source/provider identity and a digest on every receipt, never replaces a scheduled trial, and runs cleanup even after an `UNKNOWN` trial.

The sealed decision object uses 40 primary A/B/C/D blocks, 30 complete blocks as the decision floor, fixed seed `4242421`, 1,024 whole-block percentile bootstrap replicates, even-average median, nearest-rank quantiles, and nearest-0.1-ms-half-up rounding. The estimator is the paired median of `A callerWallMs - D callerWallMs` for immediate, real-512-byte, alarm-on blocks. Lower bound `>160 ms` yields `SUPPORTS_C1_PACKETIZATION`; upper bound `<=160 ms` yields `NOT_SUPPORTED_AS_NEXT_LEVER`; otherwise (including fewer than 30 complete blocks) it yields `INCONCLUSIVE`. Handler-wall, transaction-wall, and caller-minus-handler contrasts are descriptive explanatory figures only and can never select the verdict. No result can predetermine the next lever.

The checker compares the P schedule, receipts, and result by exact identity count/set; validates cleanup and receipt digests; and re-runs P's calculator. Its CI self-test records non-zero failures for post-P schedule/decision/calculator changes; missing, extra, duplicate, and replaced identities; source/P/provider mismatches; and a changed committed verdict. This is reproducible advisory evidence, not a claim of cryptographic or adversarial tamper resistance.

## Deploy/read-back and P1 result

Before P1, `scripts/deploy/g42-deploy-probe.sh` first performs a non-live build preflight. Only an explicit `G42_DEPLOY_LIVE=1` after CI is green performs the primary code-only deploy through the existing G37 primary config. It preserves the secret value in protected files, captures dry-run/deploy/read-back logs, and uses `wrangler deployments list` plus `wrangler versions view` to prove the newest provider deployment (by a unique `created_on` timestamp) is one 100-percent version whose runtime/handler/binding projection is unchanged. Historical 100-percent deployment snapshots are never treated as current merely because they occur first in the provider list. `scripts/deploy/g42-promote-deploy-evidence.mjs` copies those exact artifacts into the normal evidence commit only after rejecting any bearer/token content; the Worker bundle is bound by its recorded SHA-256. The sole stated code surface is this primary conformance route.

The first CI-green C2 deploy (`3ee8d5a`, 2026-08-28T06:59Z) created provider version `aa48724b-cd7c-4573-9bd5-d79af3784520`, but its witness correctly failed closed because the original helper selected the first historical 100-percent row rather than the newest deployment. No P1 trial or evidence promotion was performed from that failed witness. The corrected helper is covered by a reversed-history fixture and an ambiguous-timestamp rejection; the successor candidate will take the authoritative deploy/read-back and P1 evidence.

P, remote witness, raw receipt document, derived result, and per-regime P1 figures are intentionally pending until the deployed candidate's CI is green. They will be committed normally after the run, then checked with `scripts/g42-probe-check.mjs`; no P1 outcome is fabricated in this candidate.

## Non-regression checks

`npm run test:g42` runs the namespace-seam rejection matrix, G32 fence test, probe alarm/cleanup fixtures, plan/calculator/checker forced-red fixtures, P0 audit self-test, receiver/tombstone absence gate, deployment-witness mutation, and idle/colo runner fixtures. CI retains all existing required G30, G37, and G38 lanes. The probe adds no `sdt.observe/v1`, `sdt.commit/v1`, or 30-key attribute-matrix field.

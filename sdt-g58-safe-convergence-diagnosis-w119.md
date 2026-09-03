# SDT-G58-SAFE-CONVERGENCE-DIAGNOSIS-W119

Status: **blocked — the requested A/B attribution is not persisted by W118**.

This checkpoint starts from W118 source `e94ffa1eb935d901234f67738b6e9be8122a0eb3` and preserves the pushed W118 evidence head `c1366b6bdb5c1c3d681552362b82d84a8160dc87`. No deployment, cohort rerun, product repair, PR, or worker transition was performed.

## WAKE-103 decisive question

The preserved W118 paced receipt does **not** answer whether the last proven G44 frontier advanced or stayed put. Its health snapshots persist `coverage.kind`, `reason`, `partitionTag`, and `observedAt`, but no `frontierSuid`/`settled_frontier_suid`. The materialized safe head is therefore not used as a proxy for the proven frontier.

The receipt contains **three** distinct `BLOCK/UNSETTLED` groups, not four. The alleged fourth tick is not a fourth BLOCK row: the later AC6 receipt observes `SETTLED` at `1788456626566` (`2026-09-03T17:30:26.566Z`).

| W118 BLOCK tick | persisted coverage observedAt | receipt samples / last receipt | reason and partition | persisted proven frontier | Room MV safe head | Reservation MV safe head |
|---:|---|---:|---|---|---|---|
| 1 | `1788456445970` / `17:27:25.970Z` | 11 / `1788456518200` (`17:28:38.200Z`) | `source_partition_set_changed_during_scan`; `reservation:g58-reservation-9b8befe9-144-1` | **not recorded** | `063924050289760000000088044272` | `063924050289760000000088044272` |
| 2 | `1788456506391` / `17:28:26.391Z` | 9 / `1788456571052` (`17:29:31.052Z`) | same | **not recorded** | `063924050289760000000088044272` | `063924050289760000000088044272` |
| 3 | `1788456566528` / `17:29:26.528Z` | 6 / `1788456642875` (`17:30:42.875Z`) | same | **not recorded** | `063924050289760000000088044272` | `063924050289760000000088044272` |

These are exact persisted receipt values; “not recorded” means the field is absent, not that a null frontier was observed. Consequently:

- Outcome A (frontier stayed at `063924050289760000000088044272`) is **not proven**.
- Outcome B (frontier advanced beyond that SUID while both MV safe heads stayed behind) is **not proven**.
- Equating either MV safe head with the last proven frontier would violate the wake instruction and could conceal a G44/AC3 defect.

## Timeline and bounded diagnosis

The first paced reservation committed at `1788456452449` (`17:27:32.449Z`), making its unchanged 180-second deadline `1788456632449` (`17:30:32.449Z`). W118 ended at `1788456642877` (`17:30:42.877Z`) with global head `063924053368759000000482611667`, while both MV safe heads remained `063924050289760000000088044272`. The raw receipt therefore does not show a false safe row at the W118 deadline.

The direct observed condition is repeated source-universe instability: every W118 BLOCK group has the same `source_partition_set_changed_during_scan` reason and partition tag while the ten commits were paced at least 10 seconds apart (minimum `12723 ms`). This supports continuous source-partition registration as the proximate reason the scans remained BLOCKed, but it does not prove whether the retained frontier was consumed.

The observed scheduled coverage times are approximately one minute apart: `17:27:25.970Z`, `17:28:26.391Z`, and `17:29:26.528Z`. The W118 receipt has no post-cohort SETTLED group. AC6 later read a SETTLED row observed at `17:30:26.566Z`; at `17:31:23.778Z` its MV safe heads had reached the W118 final SUID `063924053368759000000482611667`. The later single reservation then reached safe visibility in `95629 ms` at `17:33:04.656Z`. This shows a later non-starved settling/catch-up result, but it cannot backfill the missing W118 per-tick frontier values.

The other candidate explanations remain bounded as follows:

1. A prior `SETTLED` row is present at `1788456386229`, but its frontier is also omitted, so “no prior frontier” versus “retained prior frontier” is undecidable from this receipt.
2. A retained-frontier catch-up failure versus a correct retained-frontier fence is exactly the A/B question; the MV head alone cannot distinguish them.
3. Source-partition-set change is directly recorded at all three BLOCK groups and is the strongest observed proximate condition.
4. The roughly 60-second maintenance cadence explains why a later SETTLED observation matters, but the W118 receipt does not persist the frontier or the catch-up result for that tick.
5. Harness censorship is not demonstrated: the final W118 snapshot still records both MV safe heads below the first target after the first deadline. AC6’s later safe result is outside that deadline and is not evidence that W118 had already become safe.

## Why the historical value cannot be recovered from the deployed rows

The G58 table is deliberately one row per service (`service_id TEXT PRIMARY KEY`) and records the last scheduled decision. The scanner cursor uses `COALESCE` to retain the prior cursor on a non-FULL result, but it does not retain a per-tick history. The W118 public health query selects only `coverage_kind`, `coverage_reason`, `coverage_partition_tag`, and `observed_at`; it omits `settled_frontier_suid`.

The read-only remote query performed with the normal config found only the later current row: `SETTLED`, `settled_frontier_suid=063924053488305000000669856102`, `observed_at=1788457527292` (`17:45:27.292Z`), with the scanner cursor at the same AC6 frontier. That row is after W118 and is not substituted for any W118 tick.

The W118 path itself still has the required G58/G44 safety wiring: the scheduled maintenance passes `coverage.frontierSuid` to catch-up, the scanner retains the cursor on BLOCK/UNKNOWN, and the live poll remains bounded by the supplied proven frontier. No fence, SafeWindow, lag, outbox, Queue, or global-D1 admission behavior was changed.

## Red-capable local guard

Added [the W119 diagnosis guard](scripts/g58-safe-convergence-diagnosis-guard.mjs) and generated [its red-baseline receipt](.artifacts/sdt-g58-w119-safe-convergence-diagnosis-guard.json). The focused runs were:

```text
node scripts/g58-safe-convergence-diagnosis-guard.mjs --self-test
  passed: equal frontier/head => Outcome A; advanced frontier/stale head => Outcome B; missing frontier => red
node scripts/g58-safe-convergence-diagnosis-guard.mjs
  status=red-baseline, currentPathFails=true, blockTicks=3, missingFrontierGroups=3
```

The guard is red on the current evidence specifically because all three BLOCK ticks lack the frontier field. It does not assert a G58 repair, and it proves the G44 invariant that a safe head may not cross an unproven frontier.

## Bounded next continuation plan

No green repair is authorized by this evidence. A next continuation must first capture the exact `settled_frontier_suid` alongside every scheduled coverage observation (or provide an existing append-only receipt containing it), without changing the 180-second line or the 20,000/120,000 ms SafeWindow bounds. There must be no new cohort stitched into W118.

If that evidence shows Outcome A, the G58 product path needs no AC3 repair; continuous partition-settling starvation should remain a separately drafted, publication-held unit. If it shows Outcome B, the next G58 repair may touch only coverage-gate ordering/retained-frontier behavior, safe catch-up cadence, lag hygiene, or safe-lane wiring, with a red guard and the G44 no-gap fence preserved.

SDT-G60/#113 remains the owner of unsafe timing and the unchanged 5,000 ms constant. SDT-G61/#114 remains the owner of projector-head/tag-state convergence. SDT-G56 remains held; no G60/G61 dispatch or G57/G59 action was taken. Because the required per-tick frontier evidence is missing, W119 is **blocked**: no PR was opened and no worker completion transition was run.

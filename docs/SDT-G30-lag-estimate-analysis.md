# SDT-G30 run 8 lag-estimate writer inventory

This is a read-only diagnosis for the B0 fixed-tag head-read stop. It does
not change SafeWindow semantics, the serialized protocol, placement, or the
G30 trace schema.

## D1 writer inventory

`serialized_dcb_lag_estimates` has exactly one production D1 writer.

| Path | Entry point and source | Write condition and value |
| --- | --- | --- |
| `packages/dcb-runtime/src/store/D1EventStore.ts:273-555` | `D1EventStore.recordDelivery` receives `arrivedAt` from `processDeliveryCore` (`packages/dcb-runtime/src/downstream/DeliveryCore.ts:168-185`). | The batch statement at `D1EventStore.ts:506-554` runs only when `deliverySource = 'queue'` and lineage, SUID-collision, contradictory-identity, and higher-SUID guards all pass. It writes `lagMs = max(0, arrivedAt - enqueuedAt)` and `observed_at = arrivedAt`; conflict handling keeps `max(decayedPriorEstimate, lagMs)`. |

The reachable production sources are intentionally asymmetric:

| Delivery route | Path | `deliverySource` | Can write the D1 lag row? |
| --- | --- | ---: | --- |
| Direct doorbell | `processDownstreamDoorbell` in `packages/dcb-runtime/src/downstream/DownstreamAdapter.ts:67-76` | `fast` | No: the SQL predicate requires `queue`. |
| Queue wrapper / batch consumer | `processDownstreamDelivery` and `handleDownstreamQueue` in `DownstreamAdapter.ts:79-140` | `queue` | Yes, subject to the batch guards above. |
| Fenced bootstrap import | `BootstrapStoreAdapter.admitBootstrap` in `packages/dcb-runtime/src/bootstrap/BootstrapStoreAdapter.ts:104-136` | `import` | No: the SQL predicate requires `queue`. |

There are no other D1 `INSERT` or `UPDATE` references to this table. In
particular, the read-side paths are query-only:

- `D1EventStore.currentLagBound` (`D1EventStore.ts:654-668`) performs one
  service-scoped `SELECT` and returns `0` for no row.
- `D1EventStore.lagBoundDiagnostics` (`D1EventStore.ts:670-690`) performs the
  same service-scoped `SELECT`, returns `{ rowFound:false, dynamicLagBoundMs:0
  }` for no row, and does not write.
- Neither function reads a commit watermark or recalculates/writes
  `now - lastWatermark`.

The only time model is therefore:

```text
queue write:
  lagMs = max(0, arrivedAt - enqueuedAt)
  nextEstimate = max(max(priorEstimate - max(0, arrivedAt - priorObservedAt), 0), lagMs)
  nextObservedAt = arrivedAt

read at now:
  dynamicLagBoundMs = max(0, estimateMs - max(0, now - observedAt))
  indeterminate = dynamicLagBoundMs > 120000
```

The 120,000 ms comparison is `safeWindowCeilingExceeded` in
`packages/dcb-runtime/src/safeWindow.ts:20-21`. A high queue lag decays only
with elapsed wall time. A fast delivery cannot change it, and a subsequent
low-lag queue delivery cannot reset it because the writer takes the maximum.

## Read-only remote snapshot and run timeline

The sealed primary-off config first passed `g30-config-check --check`, then
the id-verified `D1` binding was queried remotely at
`2026-08-25T19:44:12Z`. The query made zero writes.

| Remote fact | Observed value |
| --- | ---: |
| `serialized_dcb_lag_estimates.estimate_ms` | 70,797,953 ms |
| `observed_at` | `2026-08-25T15:39:53.000Z` |
| Matching latest queue-arrival lag | 70,797,953 ms at `2026-08-25T15:39:53.000Z` |
| Largest retained arrival lag | 80,393,078 ms |
| Published indeterminate ceiling | 120,000 ms |
| Predicted first non-indeterminate instant | `2026-08-26T11:17:50.953Z` |

The retained run-6 ledger shows its first A warm-up began at
`2026-08-25T15:25:56.436Z`; its fixed-tag read necessarily completed before
that point and succeeded. The high-lag queue arrivals started later, at
`2026-08-25T15:38:41.936Z`, after B's client-ledger capture. At the run-7
failure time `2026-08-25T19:36:45.000Z`, the formula above evaluates to
`70,797,953 - (19:36:45 - 15:39:53) = 56,585,953 ms`, which is still above
the ceiling and exactly explains the reported 500 from
`ensureWindowDeterminate`.

The earlier run-4/run-5 generic 500s had no retained response body, so this
inventory deliberately does not claim their exact dynamic value after the
fact. It does rule out a read-time `now - lastWatermark` writer as their
cause: a confirmed SafeWindow failure can only arise from a previously
written queue estimate (or a different folded read error). Run 8 records the
authenticated detail body, provider CF-Ray, and response timestamp before it
stops, making that distinction attributable rather than inferred.

## Consequence for run ordering

`g30-b0-measure.mjs` calls `establishB0Consistency` (the fixed-tag read)
before `measureB0Phase`, and `measureB0Phase` performs the five AC7 warm-up
commits. Thus A's head read is **before** the warm-ups.

That order is now explicit but is not itself a safe repair for an existing
over-ceiling row: direct warm-ups do not write this table, and a queue warm-up
preserves the maximum of the decayed prior estimate and the new lag. Run 8 is
therefore allowed to fail closed with the retained detail. Any later proposal
to alter SafeWindow semantics, clear the row, or otherwise bypass the ceiling
requires a separate authority decision.

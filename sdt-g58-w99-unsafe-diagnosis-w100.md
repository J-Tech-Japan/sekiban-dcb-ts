# SDT-G58 W100 unsafe-lane diagnosis

Status: **blocked** for a separate upstream outbox/Queue/global-D1 unit.

Starting and pushed head: `5627d8644b503c1f987d007b1655f5a7bd963299` on
`claude/sdt-g58-safe-lane-w93`. This wake did not deploy, use Wrangler, send a
request, rerun or replace the W99 cohort, open a PR, or touch SDT-G56.

This diagnosis artifact is included in the final pushed checkpoint reported
below; the branch was clean after the push.

## W99 facts correlated

W99 run `97edc4cd-5910-410a-9de9-9f9cbc6fb969` used 250 ms polling and the
unchanged 5,000 ms unsafe bound.

| Reservation | Accepted | First unsafe-visible | Result |
| --- | --- | --- | --- |
| 1 | `09:02:18.623Z` | `09:02:24.015Z` / `5,392 ms` (first fine poll elapsed `5,116 ms`) | exceeds <=5 s |
| 2 | `09:02:30.658Z` | `09:02:33.455Z` / `2,797 ms` | pass |
| 3 | accepted command path reached; old report omitted its receipt/SUID | not visible by `5,000 ms` | bounded failure |

The exact failure is `unsafe reservation g58-reservation-97edc4cd-591-3 was
not visible within 5000ms`. The completed-row nearest-rank values were p50
`2,797 ms` and p95 `5,392 ms`; no full-cohort percentile is claimed. No row-3
SUID is fabricated.

At `09:02:43.222Z`, the row-3 health read reported
`BLOCK/UNSETTLED` / `source_partition_set_changed_during_scan`, decayed lag
`6,279 ms`, SafeWindow `20,000 ms`, global head at reservation 2 SUID
`063924022950280000000689507569`, and both MV safe heads at the pre-cohort
SUID `063924019311336000000431147168`. Earlier reads were SETTLED with a null
reason. The missing global head proves this was not only a G58 MV SafeWindow
hold.

## Diagnosis

The unchanged code path is Tag append → asynchronous outbox handoff → Queue →
`D1EventStore.recordDelivery`:

1. `TagDurableObject.appendSql` commits the local event and outbox obligation;
   `registerSourcePartition` follows the append.
2. After the HTTP response, `TagDurableObject.append` calls
   `ctx.waitUntil(autoDrainAfterResponse(...))`; `autoDrainOutbox` sends the
   complete row to `DOWNSTREAM_QUEUE` without awaiting global admission.
3. The Queue consumer's `processDeliveryCore` invokes the D1 atomic batch that
   creates `dcb_events`, global membership, receipt, arrivals, and lag facts.
4. Only then do the G44 `beforeViews` gate and MV handlers run.

The row-3 global head stopped at row 2, so Queue-to-global-D1 admission had not
completed by the unsafe deadline. The W99 data cannot distinguish platform
Queue delay from an auto-drain/receiver failure, and no remote inspection or
replacement request was authorized. The G58 scheduled path only stabilizes
detector facts, reconciles source partitions, applies a proven frontier to MV
catch-up/unsafe draining, and then polls live projections; it does not write
`dcb_events` or enqueue the missing event. There is no evidence of G58-induced
D1/execution contention.

`source_partition_set_changed_during_scan` is emitted by
`GlobalCompletenessReconciler.assertSnapshotUniverseUnchanged` when the source
partition universe changes during a scan. It is a concurrent expected scan
symptom and correctly fences an unproven frontier; it is not a Queue delivery
mechanism. Therefore the root cause is outside G58 AC3 catch-up cadence and AC5
live-projection wiring. No G58 product red/green guard was added, and no
outbox/Queue/global path was modified. The preserved W99 failure remains the
baseline-red receipt.

## Harness evidence repair

`scripts/deploy/g58-safe-lane-e2e.mjs` now checkpoints accepted receipts before
any unsafe polling:

- setup-room is synchronously written after acceptance;
- each reservation is pushed with its SUID and `unsafe: null`, then written
  before the health read and `waitForUnsafe`;
- health and successful unsafe observations are checkpointed again, while a
  thrown unsafe wait leaves the accepted row in the report.

`scripts/g58-cohort-evidence-guard.mjs` is wired into `test:g58`. Its artifact
`.artifacts/sdt-g58-w100-cohort-evidence-guard.json` records schema
`sdt-g58-cohort-evidence/v1`, the preserved W99 failed receipt, and a
self-test mutation that removes the pre-poll write and goes red. No credential
contents are present.

## Validation

- `npm run test:g58` — passed, including existing G58/G44 guards, the W96 red
  receipt check, W97 same-tick witness, and the new harness guard.
- `node scripts/g58-cohort-evidence-guard.mjs --self-test` — passed; the
  removed-checkpoint mutation is red.
- `node scripts/g58-cohort-evidence-guard.mjs` — passed and wrote the raw guard
  artifact.
- `node scripts/deploy/g58-safe-lane-e2e.mjs --self-test` — passed.
- `git diff --check` — passed.

The published SafeWindow floor/ceiling (20,000/120,000 ms), unsafe 5,000 ms
bound, polling deadlines, G44 correctness, and queue/outbox semantics are
unchanged. This checkpoint is pushed after the diagnosis and harness guard;
design should schedule a separate held upstream delivery investigation before
any green product repair.

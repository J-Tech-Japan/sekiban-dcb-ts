# SDT-G61 evidence — W148/W149 post-G62 completion

W148 is a single measurement-only checkpoint on `claude/sdt-g61-post-g62-remeasurement-w148` at source `0eb83959732afe7b868fd24c34eadb2035fc9100`. It deployed the exact source to the existing `sekiban-dcb-meeting-room-cloudflare-only` worker and verified version `00e992de-296c-41f5-aa1c-983a7cd7f931`, deployment `9caa533e-97b7-453b-8a49-ff1026c259d5`, 100% traffic, and annotation `SDT-G61 W148 exact 0eb83959732afe7b868fd24c34eadb2035fc9100`. Wrangler reported non-authenticated queue trigger API error `10013` after the Worker upload; it was not retried. The exact receipts are [deploy](../.artifacts/sdt-g61-w148-deploy.json), [versions](../.artifacts/sdt-g61-w148-versions.json), and [deployments](../.artifacts/sdt-g61-w148-deployments.json).

The five Wrangler token variable names were all `UNSET` at preflight, and every Wrangler invocation stripped all five with `env -u`: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, `WRANGLER_API_TOKEN`. Conformance was path-only; the health probe returned HTTP 200. No resources, migrations, secrets, or production data were changed.

## Cohort summary

One cold-first cohort ran under run ID `bbfee5e4-c080-4dbe-b570-1719a9046073`, with 10 commits paced 11,722–12,185 ms apart. Public reservation reads used page size 1,000 and were fully paged. The 45,431,745-byte raw receipt is preserved losslessly as [sdt-g61-w148-public-cohort.json.gz](../.artifacts/sdt-g61-w148-public-cohort.json.gz), SHA-256 `39e09002b7b0dc695488dc69aa4197167eb96ef5a7baa752c577d2ad5050c297`. The expanded receipt SHA-256 was `b31b5f0b30007c43f2ff04d06b33ce36ec0d5221caf0469a117588c826295d2b`; verify with `gzip -cd .artifacts/sdt-g61-w148-public-cohort.json.gz | shasum -a 256`, or materialize with `gzip -cd .artifacts/sdt-g61-w148-public-cohort.json.gz > /tmp/sdt-g61-w148-public-cohort.json`. The expanded duplicate is not kept in the branch. [The compact JSON receipt](../.artifacts/sdt-g61-w148-public-cohort-compact.json) retains all required sample, tick, projector, tag-state, timing, proof, and Cloudflare-error fields.

| Measure | Result |
|---|---:|
| projector/tag safe proof | 10/10 within 180,000 ms |
| final-head commit-response p50 / p95 | 115,528 / 175,538 ms |
| unsafe first-visibility n | 10 |
| unsafe p50 / p95 | 87,030 / 132,641 ms |
| strictly over 5,000 ms | 9/10 |
| not visible at 5,000 ms checkpoint | 9/10 |
| still missing at end of observation | 0/10 |

## Scheduled ticks and projector outcomes

| Tick | Coverage | Proven frontier | RoomProjector | ReservationProjector |
|---|---|---|---|---|
| 09:55:06.665 | SETTLED | `063924107376858000002092497585` | attempted; no-work; same old head | attempted; no-work; same old head |
| 09:56:05.509 | BLOCK/UNSETTLED; `source_partition_set_changed_during_scan`; `reservation:g15-reservation-bf82916cac2447bb-10` | `063924107376858000002092497585` | attempted; advanced outcome; old head | attempted; advanced outcome; old head |
| 09:57:05.961 | BLOCK/UNSETTLED; `source_partition_set_changed_during_scan`; `reservation:g15-reservation-bf82916cac2447bb-10` | `063924107376858000002092497585` | attempted; advanced outcome; old head | attempted; advanced outcome; old head |
| 09:58:05.707 | SETTLED | `063924112650792000000557068186` | attempted; advanced; final head | attempted; advanced; final head |

All four ticks report every registered projector attempted (8/8 attempts), with no throw or fenced outcome. Both final heads were `063924112650792000000557068186`. All 11 cohort tag-state reads returned HTTP 200, committed version 1, and the expected SUID or a later final cohort SUID; details are in the raw receipt and the [full W148 report](../sdt-g61-post-g62-remeasurement-w148.md). Nine samples were still not visible at the 5,000 ms checkpoint, but all were observed later and none remained missing at the end of observation.

Conclusion: the pre-G62 non-advancement symptom is not reproduced on landed G62. The intermediate BLOCK ticks hold the prior proven frontier as expected, then a SETTLED tick advances both heads. W149 adds no product repair: the named causal fix is SDT-G62's cursor-aware reconciler, which supplies the retained frontier to the live poll while preserving the G44 fence.

## W149 acceptance map

W149 completes the local evidence and process continuation without another deployment or cohort. The W148 deployed receipt remains the AC1/AC4 evidence; the dedicated G61 guard below is the AC3 regression oracle.

### AC1 — deployed diagnosis

W148 recorded four scheduled ticks and both registered projectors on every tick. The first tick was `SETTLED` at `09:55:06.665Z`; ticks two and three were `BLOCK/UNSETTLED` with reason `source_partition_set_changed_during_scan` and retained frontier `063924107376858000002092497585`; the fourth was `SETTLED` at `09:58:05.707Z` with frontier `063924112650792000000557068186`. All 8/8 projector observations were attempted, with no throw or fenced outcome. The two BLOCK ticks held the prior head; the later settled tick advanced both heads. Therefore the stopping stage was not “poll never invoked”, bootstrap admission, store initialization, empty tag discovery, or checkpoint write failure. The symptom was absent after G62.

### AC2 — bounded advancement

No G61 product change was selected. The deployed behavior uses the SDT-G62 cursor-aware reconciler result and `scheduledLiveProjectionMaximumSuid`: `FULL` remains unbounded, while non-FULL ticks use the last proven frontier (or `null` when none exists). W148 demonstrates the bounded behavior: the BLOCK ticks did not cross the old proven SUID, and the later SETTLED tick advanced to the new proven frontier. G44 remains the soundness authority and its test is unmodified.

### AC3 — red-capable regression guard

The dedicated guard is [scripts/g61-retained-frontier-guard.mjs](../scripts/g61-retained-frontier-guard.mjs), wired as `npm run test:g61` in the existing `ci-g44` lane. Its behavioral oracle is deliberately retained in [test/g58-live-poll-advancement-repair.spec.ts](../test/g58-live-poll-advancement-repair.spec.ts), alongside the W112 concurrency guard. The G61 test uses a non-FULL `BLOCK` scan, a committed event below the proven frontier, and a second pending event beyond it; both `RoomProjector` and `ReservationProjector` advance to the proven SUID and neither crosses the pending SUID. The guard first records the omission mutant red, then the baseline green, and records the same mutant red again:

- red-before-green: [g61-retained-frontier-red-before-green.json](../test/fixtures/g61-retained-frontier-red-before-green.json), exit `1`;
- green baseline: [g61-retained-frontier-green.json](../test/fixtures/g61-retained-frontier-green.json), exit `0`;
- omission mutant: [g61-retained-frontier-mutant-red.json](../test/fixtures/g61-retained-frontier-mutant-red.json), exit `1`.

The mutant replaces `return scan.kind === "FULL" ? undefined : retainedFrontierSuid ?? null;` with a non-FULL `null` fence. This is the pre-fix skip shape: the scheduled poll remains observable but the two pending-below-frontier checkpoints stay unchanged. The existing G62 discard-whole-pass, start-partition-contiguity, and downstream cursor-membership mutants remain covered by `npm run test:g62`; G44 was not modified.

### AC4 — deployed proof

The W148 cold-first 10-commit cohort is the deployed proof. Both projectors reached final cohort SUID `063924112650792000000557068186` within 180,000 ms for all 10 samples, and all 11 cohort tag-state reads returned committed version `1`. The full per-sample, per-tick, per-projector, and tag-state tables are in the [W148 report](../sdt-g61-post-g62-remeasurement-w148.md) and compact receipt. No new cohort was run in W149. Unsafe visibility remains recorded only for SDT-G60 (9/10 strictly over 5,000 ms).

### AC5 — unchanged boundaries

W149 changes only the test oracle, guard script, package/CI linkage, evidence, and receipt representation. It does not change the commit path, outbox/Queue/global admission, unsafe or safe read semantics, SDT-G58 health/coverage behavior, SafeWindow, ordering, fences, or frozen trace/V1 wire. The initial W148 Queue trigger API error `10013` remains recorded and was not retried.

### AC6 — consolidated evidence

This document records the AC1 diagnosis, the named SDT-G62 causal fix, the AC3 red/green/mutant evidence, and the W148 AC4 deployment. The lossless raw receipt is retained as gzip with SHA-256 `39e09002b7b0dc695488dc69aa4197167eb96ef5a7baa752c577d2ad5050c297`; the expanded-source SHA-256 is `b31b5f0b30007c43f2ff04d06b33ce36ec0d5221caf0469a117588c826295d2b`. Verify with `gzip -cd .artifacts/sdt-g61-w148-public-cohort.json.gz | shasum -a 256`; the compact receipt is the human-reviewable durable table. The old expanded duplicate is removed from the current branch tree in an ordinary commit; because history rewriting and force-push are forbidden, the immutable W148 parent still contains its original blob.

### AC7 — process

The existing SDT-G61 execution-unit claim remains owned by implementation. W149 uses the dedicated branch `claude/sdt-g61-post-g62-remeasurement-w148` against main, keeps the evidence doc in the same PR, and runs the canonical worker transition immediately after PR creation. The final PR number, exact head, CI result, and worker transition are recorded in the W149 completion report.

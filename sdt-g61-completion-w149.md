# SDT-G61 completion — W149

Task: `SDT-G61-FRONTIER-HISTORY-CLASSIFICATION-W120` continuation / `SDT-G61-COMPLETION-W149`
Issue: J-Tech-Japan/sekiban-dcb-ts#114
Branch: `claude/sdt-g61-post-g62-remeasurement-w148`
Initial pushed W149 checkpoint: `178d30552212c5eeb3601de668726ce021918bc7`
Base/deployed source measured in W148: `0eb83959732afe7b868fd24c34eadb2035fc9100`

## Outcome

W148's single fresh deployed cohort is the authoritative AC1/AC4 proof. The pre-G62 projector non-advancement symptom did not survive landed SDT-G62: every registered projector was attempted on every observed scheduled tick, the intermediate BLOCK ticks stayed at the last proven frontier, and the later SETTLED tick advanced both `RoomProjector` and `ReservationProjector` to final cohort SUID `063924112650792000000557068186`. All 11 cohort tag-state reads returned committed version `1`; all 10 samples met the 180-second bound. No separate G61 product defect or product repair was reproduced or added. The named causal fix is SDT-G62's cursor-aware reconciler/retained-frontier behavior.

## W148 deployed evidence preserved

- Existing Worker only: `sekiban-dcb-meeting-room-cloudflare-only`.
- Existing config/bindings only: `samples/meeting-room/wrangler.cloudflare-only.jsonc`, pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1 `b416b212-4d09-413c-9b8d-7660e475772f`, and the existing outbox/DLQ.
- Active Worker version: `00e992de-296c-41f5-aa1c-983a7cd7f931`; deployment `9caa533e-97b7-453b-8a49-ff1026c259d5`; traffic 100%; annotation `SDT-G61 W148 exact 0eb83959732afe7b868fd24c34eadb2035fc9100`.
- The deploy uploaded the exact Worker but reported non-authenticated Queue trigger API code `10013`; that write was not retried. The exact receipt remains `.artifacts/sdt-g61-w148-deploy.json`.
- W148 used one cold-first cohort of 10 commits, paced 11,722–12,185 ms apart, with fully paged public reservation reads. Safe head p50/p95 was 115,528/175,538 ms; 10/10 met 180,000 ms. Unsafe visibility is evidence-only for SDT-G60: 9/10 were strictly over 5,000 ms, with p50/p95 87,030/132,641 ms.
- Scheduled ticks: `SETTLED` frontier `063924107376858000002092497585`; two `BLOCK/UNSETTLED` ticks with reason `source_partition_set_changed_during_scan`, partition `reservation:g15-reservation-bf82916cac2447bb-10`, and the same retained frontier; then `SETTLED` frontier `063924112650792000000557068186`. All 8/8 projector attempts were recorded, with no throw or fenced outcomes. Full tables are in `sdt-g61-post-g62-remeasurement-w148.md` and the compact receipt.

## W149 AC1–AC7

### AC1 — diagnosis

W148 evidence rules out the previously suspected stop stages: the scheduled poll was invoked, bootstrap admission and store initialization did not fail, registered projector jobs were produced, and no checkpoint-write failure was observed. The two BLOCK ticks correctly held the old proven frontier; a later SETTLED tick advanced both heads. The non-advancement symptom is therefore not reproduced on landed G62.

### AC2 — bounded frontier behavior

No G61 implementation change was made. The deployed behavior remains `FULL -> maximumSuid undefined` and non-FULL -> the last proven frontier (or `null` when none exists). This is the SDT-G62 cursor-aware fix and preserves G44's no-unproven-gap fence. W148 observed the expected bounded BLOCK behavior and subsequent settled advancement.

### AC3 — dedicated red-capable guard

The existing G58 W112 file `test/g58-live-poll-advancement-repair.spec.ts` now contains the minimal named G61 behavioral oracle: a non-FULL/BLOCK scan with a committed event below the proven frontier and a pending event after it; both registered projectors advance to the proven SUID and neither crosses the pending SUID. The named linkage is `scripts/g61-retained-frontier-guard.mjs`, exposed by `npm run test:g61` and wired into the existing `ci-g44` lane.

The guard receipts are:

- `test/fixtures/g61-retained-frontier-red-before-green.json`: pre-fix retained-frontier omission, exit `1`;
- `test/fixtures/g61-retained-frontier-green.json`: baseline oracle, exit `0`;
- `test/fixtures/g61-retained-frontier-mutant-red.json`: omission/skip mutant, exit `1`.

The mutant replaces `return scan.kind === "FULL" ? undefined : retainedFrontierSuid ?? null;` with a non-FULL `null` fence. The existing G62 discard-whole-pass, start-partition-gap, and cursor-membership mutants remain green-gate/red-mutant evidence under `npm run test:g62`. `test/g44-global-completeness.spec.ts` was not modified.

### AC4 — deployed proof

The W148 deployment and cohort satisfy the safe proof: both registered projector heads reached final cohort SUID `063924112650792000000557068186` within 180,000 ms for 10/10 samples, and all 11 cohort tag states were committed version `1`. The raw receipt was initially 45,431,745 bytes. It is now retained losslessly as `.artifacts/sdt-g61-w148-public-cohort.json.gz` (SHA-256 `39e09002b7b0dc695488dc69aa4197167eb96ef5a7baa752c577d2ad5050c297`) plus `.artifacts/sdt-g61-w148-public-cohort-compact.json`. Verify the expanded digest with:

```sh
gzip -cd .artifacts/sdt-g61-w148-public-cohort.json.gz | shasum -a 256
```

The expanded source digest was `b31b5f0b30007c43f2ff04d06b33ce36ec0d5221caf0469a117588c826295d2b`. The 43 MB expanded duplicate is removed from the current branch tree in an ordinary commit; the immutable W148 parent necessarily still contains that historical blob because history rewrite and force-push were prohibited.

### AC5 — unchanged boundaries

The W149 delta is test/guard/CI linkage and evidence hygiene only. It does not modify the commit path, outbox/Queue/global-D1 admission, unsafe/safe read semantics, G58 health/coverage behavior, SafeWindow, ordering, fences, trace schema, or V1 wire. No Wrangler or deployed state was used in W149. G56 remains held; G60 remains the unsafe-latency unit; no later deployment was started.

### AC6 — consolidated evidence

`docs/SDT-G61-evidence.md` records the AC1 diagnosis, named SDT-G62 cause, AC3 red/green/mutant receipts, W148 AC4 tables, receipt compression/digests, and the remaining evidence boundaries. The W148 full report and compact/raw receipts remain linked there.

### AC7 — process and verification

The existing SDT-G61 execution-unit claim remained owned by implementation. The dedicated branch was pushed without a force update. Local results on the W149 tree:

| Gate | Result |
|---|---|
| focused `test/g58-live-poll-advancement-repair.spec.ts` | pass, 2/2 tests |
| `npm run test:g61` | pass; red-before-green and omission mutant exit 1 |
| `npm run test:g41` | pass; production mutants red |
| `npm run test:g44` | pass; 8 tests and G44 production mutants red |
| `npm run test:g49` | pass; binding/migration mutants red |
| `npm run test:g51` | pass; native-span and ingestion guards green |
| `npm run test:g52` | pass; 4 tests and omission mutants red |
| `npm run test:g53` | pass; scope/control/downstream mutants red |
| `npm run test:g54` | pass; 18 tests and omission mutants red |
| `npm run test:g55` | pass; 12 tests and read-visibility guards green |
| `npm run test:g58` | pass; 15 tests and all existing G58 guards green |
| `npm run test:g62` | pass; all three G62 mutants red |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `git diff --check` | pass |

The first local `npm run test:g44` attempt stopped in its pre-existing mutation runner because this linked worktree lacked `node_modules/vitest/vitest.mjs`; the G44 contract and 8 tests had already passed. An ignored symlink to the existing parent dependency installation allowed the unchanged command to rerun and pass. No source or committed receipt was changed by that environment fix; incidental generated guard drift was reverted.

PR creation, the canonical worker transition, and final exact-head CI status are recorded in the final update to this report after those process steps complete.

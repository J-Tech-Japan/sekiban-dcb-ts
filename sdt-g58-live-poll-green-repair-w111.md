# SDT-G58 live-poll green repair W111

Status: completed (local red/green repair checkpoint)

## Scope and predecessor

The required W110 predecessor diagnosis was committed and pushed at `aa6f101`
(`SDT-G58 diagnose live poll observability seam`) and reported to orchestration
before this repair. Its immutable W109 receipt remains
`.artifacts/sdt-g58-w109-ac5-single.json`; the W110 red receipt is
`.artifacts/sdt-g58-w110-red-guard.json`.

W110 isolated the in-scope AC5 seam: reconciliation and the retained-frontier
hook completed, but the health surface derived `lastPollAt` only from
checkpoint advancement. Bootstrap admission, store initialization, an empty
poll, a retained-frontier gate, and a successful advance were therefore
indistinguishable. The W110 receipt had three actual SETTLED coverage groups,
fresh global/materialized/tag-state heads, and frozen live checkpoint rows.

## Minimal repair

The repair is additive observation around the existing scheduled
`pollLiveProjections` call:

- `LiveProjectionWorker` records one attempt timestamp for every registered
  projector before bootstrap admission/store initialization and records a
  bounded terminal outcome (`never-invoked`, `invoked-and-threw`,
  `invoked-but-no-work`, `explicitly-gated`, or `advanced`). Observation write
  errors are ancillary and cannot alter projection decisions.
- `CatchUpResult` carries the existing tag/projector identity so outcomes are
  attributed to RoomProjector and ReservationProjector without changing
  checkpoint transactions or reducer semantics.
- The additive D1 migration
  `migrations/d1/g32/0004_g58_live_poll_health.sql` persists the per-projector
  lifecycle. `readMeetingRoomHealth` reports `pollStatus`, `pollReason`, and
  the attempt timestamp as `lastPollAt`; `head` and `headAgeMs` remain derived
  from the durable checkpoint. A missing table/row is explicitly
  `never-invoked`, never a fabricated stale-success timestamp.
- The meeting-room Worker wires the observer to D1. The G44
  `assertSnapshotUniverseUnchanged` assertion, scheduled reconcile →
  retained-frontier hook → poll ordering, `maximumSuid` fence, first-unsafe
  barrier, and all commit/outbox/Queue paths are unchanged.

## Red-before-green evidence

`scripts/g58-live-poll-green-guard.mjs` consumes the W110 red receipt and
requires both projector outcomes, attempt persistence, explicit health status,
and both completeness/high-water fences. Its self-test proves these mutations
remain red:

```json
{"scheduledObserverHandoffRemovalRed":true,"attemptLifecycleRemovalRed":true,"outcomeLifecycleRemovalRed":true,"lastPollAttemptRemovalRed":true,"frontierFenceRemovalRed":true}
```

`test/g58-live-poll-green-repair.spec.ts` proves the repaired lifecycle for
both projectors, explicit retained-frontier gating, bootstrap admission
failure, and store initialization failure. The previous W110 red baseline and
mutation receipt are retained unchanged.

## Local validation

- `node scripts/g58-live-poll-diagnosis-guard.mjs --self-test` — passed; the
  historical scheduled-poll/fence/diagnosis mutations remain red.
- `node scripts/g58-live-poll-green-guard.mjs --self-test` — passed with all
  five W111 mutations red.
- `node scripts/g58-live-poll-green-guard.mjs` — passed and wrote
  `.artifacts/sdt-g58-w111-green-guard.json` after the focused Vitest suite.
- `npm run test:g58` — passed (including the focused four-test lifecycle suite,
  all earlier G58 tests, guards, and mutation checks).
- `npm run test:g44` — passed; existing G44 correctness and mutation checks
  remain green/red-capable as before.
- `npm run typecheck` — passed.
- `npm run lint` — passed with `--max-warnings=0`.

No Wrangler, deployment, credential, application request, cohort, PR, or
worker operation was performed. SafeWindow remains exactly `20000/120000` ms
and the unsafe constant remains `5000` ms. SDT-G60 outbox/Queue/global
admission ownership and SDT-G56 hold are unchanged.

## Handoff

This checkpoint is ready for the authorized W112 exact-head deployment and
deployed AC1/AC5 proof. W112 must verify actual projector-head advancement;
`lastPollAt` telemetry alone is not an AC5 pass.

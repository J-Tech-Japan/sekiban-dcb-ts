# SDT-G60 unsafe-writer diagnosis — W153

Task: `SDT-G60-UNSAFE-WRITER-DIAGNOSIS-W153`
Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Starting W152 head: `48296e900d5ee2563e109f1f4805034150d3c0f5`
Code/evidence checkpoint: `31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf`
Status: **local diagnosis and bounded repair complete; deployed measurement still required**

This continuation used no Wrangler, Cloudflare read/write, deployment, cohort,
PR, or downstream-unit operation. W152 raw evidence and the pre-existing dirty
and untracked W128/W137/W143/W144 evidence were retained in the worktree and
were not staged, reverted, or cleaned up. Production and the existing W130
arms were untouched.

## Decisive writer-path diagnosis

The W152 source had a concrete inline writer, `applyMeetingRoomUnsafeView`,
which calls `unsafe.apply` for the `mv_unsafe_receipts`/`mv_unsafe_rows` path.
However, `DeliveryCore` invoked its ordinary `views` loop only after the G44
`beforeViews` callback. On W152 every sampled delivery reached
`coverageForObligation` as `BLOCK/UNSETTLED`, so the ordinary loop returned
before `applyMeetingRoomUnsafeView` was invoked. This is the responsible
current-path cause: the unsafe writer existed inline but was gated by
completeness admission.

The other candidate path is not the unsafe-row writer. The scheduled
`drainMeetingRoomUnsafeKicks` path calls the SafeWindow/fenced
`runtime.follow` operation and writes safe `mv_rows`; it does not call
`unsafe.apply`. The W152 durable evidence agrees with the source-path proof:
`mv_unsafe_receipts=0`, `mv_unsafe_rows=0`, and `mv_rows=10`; all ten
post-admission completeness boundaries ended `BLOCK/UNSETTLED`, with detector,
RoomProjector apply, and ReservationProjector apply boundaries absent. The
rows alone are not used to infer the writer: the source inspection and the
red-capable admission fixture establish the causal path.

The smallest authorized repair is therefore to split delivery handlers into
two explicit lanes. Meeting-room unsafe handlers are marked
`admission: "independent-unsafe"` and execute after durable recordDelivery,
global-receipt read-back, and source acknowledgement but before the G44
completeness callback. They only perform the existing unsafe-window mutation;
they never advance a safe checkpoint. Unmarked handlers remain after the
existing completeness and detector gates. The scheduled path and its
`runtime.follow`/SafeWindow fence are unchanged.

The new observer records the actual `unsafe.apply` start/end and outcome with
the exact `serviceId`, `eventId`, SUID, Queue/fast transport, message
`attemptId`, projector view, and timestamp. The write is scheduled through the
active invocation's `waitUntil`; it is never awaited and observer failure is
swallowed. Direct import has no message attempt identity, so W153 deliberately
does not fabricate a correlation row for that helper. `writer_path` retains
`inline-delivery` versus `scheduled-drain`; the scheduled path has no unsafe
writer boundary because it does not write an unsafe row.

Migration `0008_g60_unsafe_writer_boundaries.sql` adds the append-only,
idempotent operational table
`serialized_dcb_unsafe_writer_boundaries`. Its key includes service, event,
writer path, view, boundary, and transport; the table is not read by
admission, acknowledgement, projection fencing, retries, or public reads.

## Red-before-green evidence

The focused red receipts are preserved under `.artifacts/`:

| receipt | command/result |
|---|---|
| [`sdt-g60-w153-unsafe-writer-red.json`](.artifacts/sdt-g60-w153-unsafe-writer-red.json) | `node scripts/g60-unsafe-writer-guard.mjs --pre-change --receipt ...`; exit `1` expected; BLOCK returns before the old ordinary view loop and no inline writer boundary is present |
| [`sdt-g60-w153-unsafe-writer-mutant-red.json`](.artifacts/sdt-g60-w153-unsafe-writer-mutant-red.json) | `node scripts/g60-unsafe-writer-guard.mjs --mutant-old-path --receipt ...`; exit `1` expected; restoring the old completeness-gated path has the same no-writer result |
| [`sdt-g60-w153-unsafe-writer-green.json`](.artifacts/sdt-g60-w153-unsafe-writer-green.json) | normal `node scripts/g60-unsafe-writer-guard.mjs`; exit `0`; exact fixture has both `start` and `end` for `ReservationProjector` and the independent BLOCK trace applies unsafe while leaving gated views unapplied |

Receipt SHA-256 values are, respectively:

```text
8f3eee4a073f44b1fa6ebd07489ec333fc28c299461c53daabc03edf9e488e51  .artifacts/sdt-g60-w153-unsafe-writer-red.json
d5faa4b8303e8f4b6837ebbdd769474706f81236d554a780ec90c42ebf56abbc  .artifacts/sdt-g60-w153-unsafe-writer-mutant-red.json
fc4a8126f76cd7b6c7d58a84982de73b4af7bb5829e9ee874ec19459fc2f0dfb  .artifacts/sdt-g60-w153-unsafe-writer-green.json
```

`test/g60-unsafe-writer.spec.ts` is the runtime fixture: the independent
unsafe handler runs once under a thrown BLOCK, while an ordinary unmarked
handler remains at zero calls. The D1 pipeline test also appends a start/end
pair, checks exact identity/path/outcome, and verifies the duplicate end is
ignored. G44's existing detector-failure mutation anchor and fence behavior
remain intact.

## W152 regression context and landing history

W152's one fresh cohort had ten observed samples, all over the unchanged
5,000 ms unsafe threshold. Its recordDelivery-to-public values were
`42096, 51305, 56696, 59898, 54700, 55459, 68403, 42843, 51553, 57983 ms`
(p50 `54,700 ms`, p95 `68,403 ms`). This is a measured regression against W95
(p50 `2,959 ms`) and the clean-main comparison (p50 `4,911 ms`), but the
different deployments, data windows, and admission states do not prove a
historical causal regression by themselves. W143 had already measured the
Queue-send-to-consumer interval at `7,186–9,175 ms` for its four strict
over-bound samples.

History makes the relevant boundary clear but does not show an unsafe-writer
move from inline to scheduled drain:

- `f7b257b` (G26) is the first identified landing of
  `applyMeetingRoomUnsafeView` and the unsafe-window writer.
- `05d9d27` (G62) is the first identified landing of the exact
  cursor-aware `coverageForObligation` delivery gate. It changed the
  completeness admission predicate, not the concrete unsafe writer's
  implementation or the scheduled drain into an unsafe writer.
- `3e5954b` added the W127 post-admission measurements, and `9eabe045` moved
  the already-existing outbox drain start; neither moved `unsafe.apply` to
  the scheduled drain.

Thus W153 identifies the first provable relevant admission change as the G62
cursor gate, while the writer itself predates it. A further claim about when
the observed latency distribution changed requires a matched deployed
measurement.

## Local verification

All commands below were local and completed successfully; no timeout, gate,
constant, SafeWindow bound, outbox/Queue/global admission behavior, ordering,
fence, G53, G55, G58, or G62 behavior was weakened.

| command | result |
|---|---|
| `npm run test:g60:unsafe-writer` | pass; 2 files / 4 tests, writer guard green with red-before-green and omission/old-path plus boundary mutants red |
| `npm run test:g60:queue` | pass; existing omission and old-waitUntil mutants red |
| `npx vitest run --config vitest.config.ts test/d1-pipeline.spec.ts` | pass; 1 file / 12 tests |
| `npm run test:g26` | pass; 4 files / 32 tests |
| `npm run test:g44` | pass; 8 tests and all four existing production mutants red |
| `npm run test:g41` | pass; 8 tests and existing production mutants red |
| `npm run test:g49` | pass; binding, migration, and lineage mutants red |
| `npm run test:g51` | pass; selected 4 tests, 29 existing-pattern skips, and all listed local guards pass |
| `npm run test:g52` | pass; 4 files / 18 tests and omission mutants red |
| `npm run test:g53` | pass; 1 file / 10 tests and scope mutants red |
| `npm run test:g55` | pass; 4 files / 12 tests and read-visibility guard pass |
| `npm run test:g58` | pass; 5 files / 15 tests and existing G58 guards/mutants pass |
| `npm run test:g62` | pass; G62 guard green and its three mutants red |
| `npm run typecheck` | pass / exit `0` |
| `npm run lint` | pass / exit `0` |
| `git diff --check` | pass / exit `0` |

## Checkpoint and next boundary

Code, migration, focused test/guard, and W153 red/green receipts are committed
in `31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf` and pushed to
`origin/claude/sdt-g60-clean-preg53-ab-w124`. W153 has no deployed proof and
does not claim AC3 completion. The next bounded continuation may deploy the
exact pushed source and run the authorized fresh cohort to determine whether
the restored inline writer removes the remaining admission/Queue residual;
W153 itself performed no remote operation.

The `5,000 ms` unsafe contract remains unchanged and unsafe timing remains
G60 evidence. No G58/G62/G61 surface, SafeWindow bound, outbox/Queue/global
admission path, or production resource was changed.

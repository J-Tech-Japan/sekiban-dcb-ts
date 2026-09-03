# SDT-G58 ReservationProjector re-entry green repair — W106

Status: **completed**. This is a local production-runtime repair checkpoint;
no deployment, application request, cohort, PR, worker completion, or
host/G56/G60 operation was performed.

## Boundary and preserved receipts

- Starting pushed checkpoint: `c28c92beb346c566617a0697fb4afbf9c565e8bc`.
- Product/test/guard commit: `7799134d4bdc786100e064808f5c9703e22193cf`.
- W102-W105 receipts and documents are unchanged and remain the only remote
  evidence. In particular, the W105 diagnosis remains the source for this
  focused repair seam.
- New red receipt: `.artifacts/sdt-g58-w106-red-baseline.json`.
- New green receipt: `.artifacts/sdt-g58-w106-reentry-green.json`.

## Red-before-green production witness

`test/g58-reservation-reentry.spec.ts` runs the production
`MaterializedViewCatchUpRuntime` and `D1MaterializedViewStore` against the
versioned MV schema. It constructs independent RoomProjector and
ReservationProjector views, one retained `maximumSuid` frontier, and the
controlled clock `nowMs=1788428500000`:

- the shared old event is eligible at `nowMs-30000`;
- Room's target event is eligible at `nowMs-30000` and reaches the target;
- Reservation's same-frontier target event is recent at `nowMs-1000`, so its
  first follow stops at the old SUID and leaves the first unsafe event alone;
- the acquired kick's follow returns before `lease.targetSuid`.

At the checkpoint baseline, the exact command

```text
npx vitest run --config vitest.config.ts test/g58-reservation-reentry.spec.ts --no-cache
```

exited 1. The kick settlement assertion expected `dirty=1` with no lease owner
but received `dirty=0`; this is the preserved irreversible-clean defect, not a
test-only model result.

## Minimal repair and green re-entry

`UnsafeWindowMaterializedViewStore.finishKick` now requires the reached SUID
and performs one guarded SQL update. It clears the lease and retains `dirty=1`
when `target_suid` is still greater than the reached checkpoint. The sample
unsafe drain passes `result.instance.lastSuid` from its bounded follow. The
first-unsafe barrier and retained-frontier fence therefore remain intact, but
the next scheduled tick can acquire the still-dirty kick.

At `nowMs+21000`, the same target is SafeWindow-eligible. The second kick is
acquired, ReservationProjector reaches the target, and the final kick state is
`dirty=0` with no lease owner. RoomProjector remains independently converged.
The re-entry is 21 seconds after the first decision, well inside the unchanged
180-second G58 safe-visibility deadline. No request-side wait or busy loop was
added.

The green guard receipt records red-capable mutations for:

1. removing the target-not-reached SQL comparison;
2. omitting the reached-checkpoint hand-off from the production drain;
3. removing the first-unsafe SafeWindow barrier; and
4. removing the retained `maximumSuid` frontier from the unsafe drain.

All four mutations are red. Existing G23 coverage also remains green for a
new dirty arrival during a held kick, and `finishKick` still refuses a dirty
row (`WHERE dirty = 0`) rather than clearing concurrent work.

## Validation

- `npx vitest run --config vitest.config.ts test/g58-reservation-reentry.spec.ts --no-cache` — 1 test passed.
- `npx vitest run --config vitest.config.ts test/g23-unsafe-window.spec.ts --no-cache` — 27 tests passed.
- `node scripts/g58-reservation-reentry-guard.mjs --self-test` — passed; all four mutations red.
- `node scripts/g58-reservation-reentry-guard.mjs` — passed; green receipt written.
- `npm run test:g58` — passed (3 files, 8 tests, all existing G58 guards/mutants).
- `npm run test:g44` — passed; G44 correctness and mutation lanes unchanged.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero warnings.

## Changed paths

- `packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView.ts`
- `samples/meeting-room/src/d1-mv.ts`
- `test/g23-unsafe-window.spec.ts` (required reached-SUID call-site update)
- `test/g58-reservation-reentry.spec.ts`
- `scripts/g58-reservation-reentry-guard.mjs`
- `package.json` (G58 gate wiring)
- `.artifacts/sdt-g58-w106-red-baseline.json`
- `.artifacts/sdt-g58-w106-reentry-green.json`
- `docs/SDT-G58-evidence.md`
- this report

SafeWindow bounds (20,000/120,000 ms), the 5,000 ms unsafe constant, G44/W97/
W104 behavior, W102-W105 evidence, upstream outbox/Queue/global admission,
SDT-G56, and SDT-G60 state are untouched. This checkpoint is ready for the
next orchestration step; it does not open a PR or complete the worker.

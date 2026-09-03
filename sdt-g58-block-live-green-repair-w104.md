# SDT-G58 BLOCK live-projection green repair — W104

Status: **completed**

This checkpoint started from `5641a09066f7d4318da1d48e3187b37dafab7fd1` on
`claude/sdt-g58-safe-lane-w93`. It performed no deployment, Wrangler action,
application request, cohort, D1 reset, PR operation, or worker completion.

## Repair

The product/guard commit is
`b468c17262fc642f5bf94a7cabfae2ebb9d11d28` (`SDT-G58 repair BLOCK live
projection polling`). The Cloudflare-only scheduled path now runs:

```text
stabilizeDownstream → fresh G44 reconcile → beforeLiveProjectionPoll
  (retained-frontier MV catch-up/drain) → pollLiveProjections
```

The W103 defect was the early return after the hook on every non-FULL scan.
That return is removed. The hook returns the persisted last proven frontier;
`scheduledLiveProjectionMaximumSuid` maps FULL to `undefined`, BLOCK/UNKNOWN/
FAILED to that retained SUID, and a missing retained cursor to `null`. The
optional fence is propagated through both single-tag and all-tag polling, and
`ProjectionRuntime` stops before any event above the maximum. Thus a BLOCK tick
still invokes the live poll, but it cannot cross an unproven source gap. FULL
poll ordering and its unbounded behavior remain unchanged.

`test/g58-safe-lane-diagnosis.spec.ts` adds a deterministic ProjectionRuntime
fixture proving retained-frontier-only advancement, zero advancement for a
null frontier, and normal advancement for an unbounded FULL poll. Existing W97
FULL/BLOCK order witnesses remain. `scripts/g58-block-live-green-guard.mjs`
checks the scheduler order and all propagation points and rejects mutations
that restore the W103 early return, remove the scheduler fence, or remove the
ProjectionRuntime high-water check. It also verifies the preserved historical
`.artifacts/sdt-g58-w103-red-guard.json` (`status=red-baseline`,
`livePollCalled=false`). The green guard receipt is
`.artifacts/sdt-g58-w104-green-guard.json`.

The G44 source contract checker was updated only to require the new
scanner-derived frontier fence; `test/g44-global-completeness.spec.ts` and its
correctness fixtures were not modified. The sample returns its persisted
coverage frontier to the runtime hook. No first-unsafe SafeWindow barrier,
20,000/120,000 ms bounds, 5,000 ms unsafe constant, minimum-across-tags
aggregation, per-view scheduling, G44 fence, W97 behavior, or SDT-G60-owned
outbox/Queue/global-admission path changed.

## Validation

All requested local gates passed:

- `npm run test:g58` — passed (2 files, 6 tests; existing G58 lanes plus W104
  guard and mutation checks).
- `npm run test:g44` — passed (8 tests and all four production mutation cases
  red as expected).
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `node scripts/g58-block-live-green-guard.mjs --self-test` — passed;
  early-return, scheduler-fence, and runtime-fence mutations were red.

The W103 pre-fix receipt and diagnosis document remain unchanged. This is a
local focused green-repair checkpoint only; a later authorized wake may run
deployed safe/live proof.

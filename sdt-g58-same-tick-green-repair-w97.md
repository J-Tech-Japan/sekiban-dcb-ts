# SDT-G58 same-tick green repair (W97)

Status: **completed checkpoint**. This wake implements only the focused green
repair for the W96 same-tick G44 frontier diagnosis. It did not deploy, send a
new application request, rerun a cohort, implement unrelated AC4 hygiene,
open a PR, or complete the worker.

## Boundary and preserved evidence

- Branch: `claude/sdt-g58-safe-lane-w93`.
- Starting checkpoint: `afd6041deb04c51b9bf15e005c619e0012bcdd64`.
- Final pushed head: recorded after validation below.
- W95 cohort: `5588d9cc-b508-41f4-a332-f6464721e747` (not rerun or stitched).
- W96 red receipt: `.artifacts/sdt-g58-w96-red-guard.json` (unchanged,
  `status=red-baseline`, `exitCode=1`).
- No Wrangler use was needed.

## Focused repair

Added `CloudflareOnlyWorkerOptions.beforeLiveProjectionPoll` in
`packages/dcb-runtime/src/cloudflare.ts`. The runtime now reconciles G44 once,
then invokes this hook, then invokes the existing live-projection poll for a
FULL scan. The sample's hook reads the freshly persisted coverage and calls
`runMeetingRoomScheduledMaintenance` with `freshCoverage`, so safe MV
catch-up and unsafe-kick draining consume the newly proven frontier in the
same scheduled tick. The outer sample scheduled handler now calls the runtime
directly, avoiding a duplicate stale-frontier pass.

The fresh safe-lane path records the current coverage, catches up and drains
through its frontier, and returns before the runtime's live poll. A BLOCK or
other non-FULL result carries the reconciler's retained last-settled cursor;
only that frontier is passed to catch-up/drain and the BLOCK reason is recorded.
The existing SafeWindow and gap fences are unchanged. A TAG-omitted local
fixture keeps its prior unrestricted seam so G25 scheduled recovery remains
valid; deployed primaries use the fresh TAG-backed path.

## Guard transition

`test/g58-safe-lane-diagnosis.spec.ts` now has two green fixtures:

1. `W97 GREEN: applies a freshly scanned FULL frontier in the same scheduled
   tick` proves fresh scan → record → catch-up/drain at the fresh frontier →
   live poll.
2. The BLOCK fixture proves only the last proven frontier is used and the
   `source present/global receipt absent` reason is retained.

`scripts/g58-safe-lane-diagnosis-guard.mjs` runs the focused fixture expecting
green and verifies the W96 red receipt is still present. It wrote
`.artifacts/sdt-g58-w97-green-guard.json`:

```json
{"guard":"g58-w97-same-tick-frontier","status":"green","report":".artifacts/sdt-g58-w97-green-guard.json","baseline":".artifacts/sdt-g58-w96-red-guard.json","exitCode":0}
```

The normal `test:g58` package gate directly runs the green fixture, existing
G58 tests/guards, the production omission mutant, and the green diagnosis
runner. The existing G44 test file was not modified and its mutation lane
remained green with all expected red proofs.

## Validation commands

- `npm run test:g58` — passed: 2 files / 5 tests, existing G58 static and
  mutation guards, deployed-script self-tests, and green diagnosis guard.
- `npm run test:g44` — passed unchanged: 8 tests and four production mutants
  red.
- `npm run test:g25` — passed: 3 tests, including scheduled unsafe recovery.
- `npm run test:g31` — passed: 33 tests and wait-for contract.
- `npm run typecheck` — passed (workspace builds plus root `tsc --noEmit`).
- `npm run lint` — passed (`eslint . --max-warnings=0`).
- `npm run diagnose:g58` — passed and preserved the W96 red receipt.

No timeout, gate, SafeWindow bound, G44 test, W95 raw evidence, SDT-G56
surface, or deployment state was changed.

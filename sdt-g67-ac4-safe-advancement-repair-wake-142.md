# SDT-G67 AC4 safe-advancement repair — W142

## Checkpoint

- Task: `SDT-G67-AC4-SAFE-ADVANCEMENT-REPAIR-WAKE-142`
- Branch: `claude/sdt-g67-local-wake-w142`
- Starting pushed head: `1e110d9427066293bf018ca8558dc2b5e9fce1bf`
- Final pushed head: `c4f4d948cce153c797f35ab8ce352ea838d75816`
- Source under measurement: `246c4f21eb69c8f8f0f7c1a513e7f915ca7c6d51`
- Cloudflare/Wrangler/deployment/reset operations: none
- Semantic disposition: **blocked at the frozen SafeWindow boundary; no SafeWindow/frontier/reader bypass was made**

The checkpoint adds observation-only durable attribution and a deterministic local
oracle. It does not claim AC4 deployed acceptance or alter G44/G62 semantics.

## End-to-end finding

The W155-C rerehearsal did not show a missing Queue-to-safe-lane handoff. The
candidate produced 46 owner-attributed completed Queue kicks, with catch-up p95
`1242 ms`, but safe visibility p95 was `119133 ms`. Response p95 was `3411 ms`
versus parent `3994 ms`, and unsafe p95 was `2961 ms` versus `3173 ms`; therefore
the observed tail is in safe advancement rather than Queue delivery or unsafe
admission.

The new cron-disabled local oracle follows one real D1 delivery through the same
paths used by the Worker:

1. `D1EventStore.recordDelivery(..., "queue")` commits the event and receipt.
2. The G44 reconciler reaches a `SETTLED` coverage result for the exact delivery
   SUID.
3. Both RoomProjector and ReservationProjector catch-up paths execute.
4. The serialized safe reader sees the exact event/SUID when it is outside the
   published SafeWindow.

The corresponding recent-event fixture reaches the same `SETTLED` coverage and
the same Queue-owned kick, but the MV catch-up records `safeWindowMs >= 20000`,
`advancedSourceEvents=0`, `appliedEvents=0`, `indeterminate=false`, and unchanged
safe heads before and after. The serialized safe reader remains empty with cron
disabled. This is the expected SafeWindow fence, not an omitted effective
catch-up. The production `MaterializedViewCatchUpRuntime.followGeneration`
stops at the first event whose `lastArrivedAt` is newer than `now - windowMs`;
cron later retries after the window. The approximately 119-second observed tail
is consistent with that published SafeWindow ceiling, not with the measured
Queue-kick/catch-up duration.

Consequently, making the recent event safe in the same kick would require
bypassing or changing SafeWindow, widening frontier certification, or changing
safe-reader semantics. Each is outside this G67 slice and would weaken the
frozen G44/G62/G55 contract. No such product repair was made. The remaining
decision requires an explicit packet/design ruling if AC4 is intended to demand
safe visibility before the existing SafeWindow permits it.

## Scoped implementation

- Added migration `migrations/d1/g32/0013_g67_safe_lane_catch_up_observations.sql`.
- Persisted `delivery_suid` and `catch_up_result_json` on safe-lane pass rows.
- Carried the exact Queue message SUID into the pass owner and recorded, per
  projector, before/after safe heads, dynamic lag bound, SafeWindow, advanced
  source-event count, applied-event count, and indeterminate state.
- Kept the existing coverage, frontier, SafeWindow, MV ordering, Queue
  disposition, and cron-backstop decisions unchanged. Observation persistence
  is not read by admission or frontier certification.
- Added the real D1/G44/MV/public-safe-reader cron-disabled tests:
  - `AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader`
  - `AC4: cron-disabled Queue kick records the SafeWindow stop instead of claiming safe advancement`
- Added `omit-effective-queue-safe-catch-up` to the G67 guard. Its mutant
  replaces the effective catch-up with a duplicate drain; the positive safe
  reader oracle goes red. The four existing G67 mutants remain unchanged and
  red.

## Red/green evidence

- Focused command:
  `npx vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/g67-safe-lane.spec.ts`
  - green: 1 file, 8 tests.
- `node scripts/g67-safe-lane-guard.mjs --self-test`
  - green; five mutation anchors, including the new effective-catch-up anchor.
- `node scripts/g67-safe-lane-guard.mjs --pre-fix`
  - red-before-green; all five mutants fail their positive oracle.
- `node scripts/g67-safe-lane-guard.mjs`
  - green; `omit-event-driven-kick`, `reuse-first-coalesced-owner`,
    `advance-under-block-frontier`, `await-queue-kick-hook`, and
    `omit-effective-queue-safe-catch-up` are all red.
- `npm run test:g67:forced-red`
  - green in normal mode; 8 focused tests pass and the five mutation receipts
    are red. The environment did not set `SDT_G67_FORCE_FAILURE`.

## Regression gates

The following completed successfully in this worktree; mutation failures shown
by these runners are expected red receipts, not lane failures:

- `npm run test:g44` — G44 contract, 8 tests, and four production mutants red.
- `npm run test:g58` — 5 files, 15 tests; G58 guards/mutants green/red as
  designed.
- `npm run test:g61` — retained-frontier green plus red-before-green mutant.
- `npm run test:g62` — AC1–AC3 green plus three G62 mutants red.
- `npm run test:g60:required` — direct, Queue, durable-hop, unsafe-writer, and
  post-admission guards green; six G60 mutants remain red.
- `npm run test:g65:required` — 2 files, 17 tests; G65 guards and idempotence
  oracle green with expected red mutant receipt.
- `npm run test:g26` — 4 files, 32 tests.
- `npm run test:g27` — 1 file, 6 tests.
- `npm run lint` — pass.
- `npm run typecheck` — pass, including workspace builds.
- `git diff --check` — pass.

The aggregate CI-equivalent command `npm run check` passed lint, typecheck, and
`test:g28:compile-fail`, then stopped at `npm run test:g28:boundaries` because
the environment's `npm pack --dry-run` child exited 1 without a package error.
The first receipt was:

```text
SDT-G28 boundary gate: npm pack failed: npm error Log files were not written due to an error writing to the directory: /Users/tomohisa/.npm/_logs
```

One environment-only retry used `npm_config_logs_dir=/tmp`; it still exited 1,
with npm reporting only `A complete log of this run can be found in: /tmp/...`
and no package diagnostic. No test, workflow, timeout, or gate was changed.
The directly affected G26/G27/G44/G58/G60/G61/G62/G65/G67 lanes above were run
independently and passed.

The repeated local Vitest warning about a non-empty
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` was environment
output only; no Cloudflare operation was invoked.

## Boundary and next decision

This is a durable local instrumentation/guard checkpoint, not a claim that the
W155-C safe-p95 target passed. The persisted rows now distinguish a completed
event-driven pass from a pass that correctly stops at SafeWindow, with exact
delivery SUID and safe-head progression. A future acceptance change must first
rule whether the existing SafeWindow is allowed to remain the safe-read fence;
this task does not authorize changing it.

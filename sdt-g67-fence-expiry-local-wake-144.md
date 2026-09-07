# SDT-G67 fence-expiry local checkpoint — W144

## Disposition

- Issue: `J-Tech-Japan/sekiban-dcb-ts#129`
- Branch: `claude/sdt-g67-local-wake-w142`
- Parent of this checkpoint: `91c36df5434895cccbbe03beeb5d7f8b5639857f`
- Implementation checkpoint included in this evidence: `2d0fed0`; the final pushed evidence-head SHA is reported by the canonical handoff after this document is committed.
- Scope: local AC1 only; no Wrangler, Cloudflare, deployment, reset, resource, PR, review, merge, or closeout action
- Contract read: GitHub issue #129 was reread before editing on 2026-09-06. The amended contract retains the existing SafeWindow (20,000 ms floor, 120,000 ms ceiling), G44/G62 frontier proof, cron backstop, and no-polling requirement. The amended deployed target is SafeWindow + 10,000 ms; this checkpoint makes no target or SafeWindow change.

The W143 evidence is preserved unchanged. W143 established that the missing mechanism was a deadline re-kick: the event-driven pass could stop at the SafeWindow fence and leave no durable trigger for the earliest deferred event. This checkpoint implements that mechanism locally and does not claim deployed AC4/AC5.

## Implemented boundary

The safe lane now records and schedules the existing semantics without making observer state authoritative:

1. `MaterializedViewCatchUpRuntime` returns the first deferred event SUID, its `lastArrivedAt`, `lastArrivedAt + SafeWindow`, and a precise stop reason (`safe_window_fence`, `safe_window_ceiling`, or `frontier_fence`). The read/fence/frontier algorithm is unchanged.
2. The meeting-room pass records `delivery`, `fence-expiry`, `coverage-retry`, or `cron` in the additive `trigger_kind` ledger column, together with stop deadline/reason, delivery owner, coverage/frontier, catch-up result/timing, and safe heads before/after. The legacy `trigger` column remains compatible (`kick` for non-cron requests, `cron` for cron); health/read parsing prefers the new exact trigger field.
3. The existing service-scoped `BOOTSTRAP` Durable Object owns one alarm key. It transactionally retains the earliest outstanding deadline and replaces a later one with an earlier one. The alarm re-enters the same single-flight safe pass with the persisted `fence-expiry` or `coverage-retry` trigger and owner identity. There is no always-on polling or new binding/resource.
4. A `BLOCK/UNSETTLED` or other non-fence stop schedules bounded exponential `coverage-retry` backoff, capped at 30 seconds, and records the reason. A SafeWindow stop schedules the exact event deadline. Delivery/Queue acknowledgement remains notification-only through `waitUntil`; no observer or safe-lane work participates in Queue disposition, commit response, G44 certification, ordering, or MV correctness.
5. Migration `0014_g67_safe_lane_fence_expiry.sql` is additive only. The local G44 D1 helper applies it when the three new columns are absent. The G49 parity guard understands the entrypoint-owned Bootstrap wrapper and still rejects binding/migration omissions.

Scoped files are the runtime catch-up result, meeting-room safe-lane scheduler/worker/D1 observation path, additive migration/test helper, G49 parity parser, G67 guard/tests/fixtures, and `docs/safe-lane.md`. No trace, V1 wire, SafeWindow, G44/G62/G61, Queue, or unrelated product surface was changed. Existing unrelated dirty artifacts remain unstaged.

## Red/green evidence

The red receipt was captured before the green run:

```text
node scripts/g67-safe-lane-guard.mjs --pre-fix
exit 1 (expected red)
receipt: test/fixtures/g67-red-before-green.json
```

It records all six existing G67 mutations plus the new `omit-fence-expiry-trigger` mutation as red. The preserved mutations are:

- omitted event-driven kick;
- reuse of the first rather than latest coalesced owner;
- advancing under a BLOCK frontier;
- awaiting the Queue kick hook;
- omitting effective Queue safe catch-up;
- omitting the fence-expiry trigger.

The green and mutant run then passed:

```text
node scripts/g67-safe-lane-guard.mjs
exit 0
result: g67-green-and-mutants-red
receipts: test/fixtures/g67-green.json, test/fixtures/g67-mutants-red.json
```

Focused behavior:

```text
npx vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/g67-safe-lane.spec.ts
10 tests passed
```

The focused tests prove: single-flight/coalescing, earliest alarm deadline selection, retained-frontier BLOCK behavior, ten cron-disabled delivery passes, SafeWindow stop attribution, and a recent Queue delivery that becomes safe only after the explicit `fence-expiry` pass. The expiry test verifies the exact delivery SUID, deadline, `safe_window_fence` stop, `fence-expiry` trigger, and subsequent safe head. `g67-mutants-red.json` contains a failing receipt for every required omission/reordering mutant.

## Local gates

Passed commands (exit 0):

```text
npm run lint
npm run typecheck
npm run test:g44
npm run test:g58
npm run test:g61
npm run test:g62
npm run test:g60:required
npm run test:g65:required
npm run test:g67
npm run test:g26
npm run test:g27
npm run test:g43
npm run test:g49
npm run test:g41
npm run test:g45
npm run test:g46
npm run test:g21
npm run test:g25
npm run test:g17
npm run test:g52
npm run test:g37:evidence
npm run test:g22
npm run test:g23
npm run test:g24
npm run test:g38:prep
npm run test:g42
npm run test:g28:compile-fail
npm run test:g28:boundary:source
npm run test:g28:boundary:negative
npm run test:store-contract
npm run test:d1
npm run test:mv
npm run test:boundaries
npm run test:consumer
node scripts/g49-binding-parity-check.mjs --self-test
git diff --check
```

The full serial Vitest run also passed after restoring the known G30 mutation:

```text
npx vitest run --config vitest.config.ts --no-cache --maxWorkers=1
92 test files passed, 1 skipped; 776 tests passed, 1 skipped; exit 0
```

The following are environment/runner exceptions and are not reported as green:

- `npm run check` exits 1 at `npm run test:g28:boundaries`; `npm pack --dry-run --json --workspace @sekiban/dcb-domain` cannot write the root-owned npm cache (`EPERM`, `/Users/tomohisa/.npm/_cacache/tmp/...`) and its default log directory is also unwritable. `npm_config_logs_dir=/tmp npm run test:g28:boundaries` still exits 1; the preserved npm log reports only npm exit code 1. The independent G28 source and negative-fixture gates pass.
- `npm test` with the default local worker configuration exits 1 with 5 timeout/race failures across 777 tests, including the known G43 AC6 concurrent alarm assertion and local DO teardown/timeout signatures. The serial full Vitest run above is the deterministic local result. Isolated `npm run test:g43` is green.
- `npm run test:g30` reached its trace mutation phase and then produced no output for the bounded observation window; it was terminated with exit 130. The exact single-worker full-suite failure while that runner's temporary mutation was present was G30 `IDLE_EXPERIMENT_SCHEDULE_MS`: observed `[2000,15000,179000]`, expected `[2000,15000,180000]`. The temporary `179000` edit was restored to `180000` and the serial full suite subsequently passed. No trace change is staged.

No timeout, assertion, CI gate, scheduler expectation, Queue behavior, or fixture acceptance was weakened. Build/deploy scripts that would invoke Wrangler were not run under the local-only boundary.

## Remaining obligation

This is a pushed deploy-free checkpoint only. The next unit must deploy the repaired candidate and collect a fresh arm cohort with per-sample SafeWindow, fence wait, delivery-to-applied timing, residual scheduling wait, trigger provenance, and safe-head progression. Production AC5 remains conditional on that separate deployed proof; no deployed claim is made here.

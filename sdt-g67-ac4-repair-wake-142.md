# SDT-G67 AC4 repair W142

Task: `SDT-G67-AC4-REPAIR-WAKE-142`  
Issue: J-Tech-Japan/sekiban-dcb-ts#129  
Branch: `claude/sdt-g67-local-wake-w142`  
Starting checkpoint: `540aab1db3ae48aea9d8f7c6fb4e956058c6c027`  
Remote/deployment action: none. Wrangler and Cloudflare were not invoked.

## Result

This is a pushed local repair checkpoint. The W142 arm deployment remains a
measurement-only blocked receipt; no new arm or production cohort was run.
The repair makes the Queue safe-lane kick notification-only and defers its
observer/scheduler work behind `waitUntil`, persists kick/cron pass lifecycle
evidence, and leaves the G44/G62 pass body and frontier certification rules
unchanged.

## Causal finding

The W142 candidate arm had safe p95 `117,661 ms` against the `60,000 ms` arm
target and response p95 `3,072 ms` versus the true parent `2,866 ms` baseline
(`+206 ms`, over the `+150 ms` allowance). Unsafe visibility was `10/10`
under `5,000 ms`; safe visibility was `10/10` under `180,000 ms`. The
candidate receipt remains blocked and is not reclassified by this local work.

The persisted W142 health rows cannot prove that a Queue kick was scheduled,
started, coalesced, completed, or failed. The pre-repair source had a Queue
callback, but only the cron path wrote `serialized_dcb_safe_lane_history`;
there was no durable kick lifecycle. Therefore the data does not support the
stronger claim that cron caused the slow safe p95. It proves incomplete trigger
provenance, not a measured cron-versus-kick causal split.

The pre-repair Queue hook was also typed as awaitable and the scheduler was
started synchronously before its `waitUntil` promise was registered. That
created an avoidable delivery-path boundary: safe-lane observer/scheduler work
could begin while Queue handling was still returning its disposition. The
repair makes this hook explicitly notification-only, defers its observer write
and scheduler start through `Promise.resolve().then(...)` registered with
`ctx.waitUntil`, and keeps the Queue disposition and commit semantics
independent of safe-lane work. This is a bounded local correction; deployed
latency and the AC4 arm target remain unproven until a later authorized run.

## Scoped implementation

- Added migration `migrations/d1/g32/0011_g67_safe_lane_passes.sql` for the
  observation-only `serialized_dcb_safe_lane_passes` lifecycle ledger. It
  records `kick`/`cron`, `scheduled`/`running`/`completed`/`failed`/
  `coalesced`, observed times, coverage kind/reason/partition/frontier, and
  safe heads before/after.
- Added best-effort lifecycle/head observation to the existing health surface;
  observer failures cannot affect Queue acknowledgement, G44 certification,
  or safe catch-up.
- Changed the Queue callback contract in
  `packages/dcb-runtime/src/downstream/DownstreamAdapter.ts` and the
  Cloudflare adapter to notification-only. Successful stored/idempotent
  `recordDelivery` results still notify; a `recordDelivery` failure does not.
- Deferred kick observer/scheduler start behind `waitUntil` and retained the
  single-flight/coalesced scheduler. Cron still calls the same
  `runMeetingRoomScheduledMaintenance` body and remains the backstop.
- Added local lifecycle, non-awaiting, single-flight, cron-disabled paced, and
  BLOCK/UNSETTLED retained-frontier coverage. Existing G44/G62/G61/G60/G65
  behavior and guards were not weakened.

## Red/green evidence

`npm run test:g67` passed with 1 file and 6 tests. The guard produced:

- `test/fixtures/g67-red-before-green.json`: red-before-green receipt;
- `test/fixtures/g67-green.json`: green receipt;
- `test/fixtures/g67-mutants-red.json`: all three mutants red:
  `omit-event-driven-kick`, `advance-under-block-frontier`, and
  `await-queue-kick-hook`.

The production mutation probes are source-level red-capable checks. The six
existing SDT-G60 mutants were retained unchanged and remained green in the
focused `test:g60:required` lane.

## Local gate record

Passing focused/current lanes (exit `0`):

- `npm run lint`
- `npm run typecheck`
- `npm run test:g67`
- `npm run test:g44`, `npm run test:g58`, `npm run test:g60:required`,
  `npm run test:g61`, `npm run test:g62`, and `npm run test:g65:required`
- `npm run test:g43`, `npm run test:g37:evidence`, `npm run test:g52`
- `npm run test:g21`, `g22`, `g23`, `g24`, `g25`, `g26`, `g27`, `g28`,
  `g29` mapping/delivery/diagnostics/compatibility/domain-source/
  authoring-doc/sample/witness/candidate, `g31`, `g30:candidate`,
  `g31:candidate`, `g32:candidate`
- `npm run test:g38:prep`, `npm run test:g42`, `npm run test:g45`,
  `npm run test:g46`, `npm run test:g49`, `npm run test:g41`
- `npm run test:store-contract`, `npm run test:d1`, `npm run test:mv`,
  `npm run test:boundaries`, and `npm run test:consumer`
- `git diff --check`

The deliberate forced-red reachability commands for G21–G29, G31, G38,
G42–G46, G49, G53–G56, G58, G61, G62, G65, and G67 all returned exit `1`
with their corresponding expected forced-failure output. Those are red
receipts proving the gates are wired, not failed normal gates.

The repository aggregate `npm run check` returned exit `1` in its parallel
`npm test` stage. Its exact failures were the pre-existing timing/race class:

- `test/commit.spec.ts` AC7 timed out at the unchanged 5,000 ms;
- `test/g43-tag-sql.spec.ts` AC6 got `waitForConfiguredAlarm(...) === null`
  at line 446;
- `test/repair.spec.ts` timed out at the unchanged 5,000 ms;
- `test/tag.spec.ts` G5 timed out at the unchanged 5,000 ms;
- the log also contains workerd `EnvironmentTeardownError` pending-RPC
  failures.

The isolated `npm run test:g43` passed 3 files/20 tests, so the G43 result is
classified as a parallel runner race rather than a G67 assertion failure.

Two full-workflow runner exceptions are preserved rather than called green:

- `npm run test:g30` emitted its complete trace/B0/manifest and mutation
  output, then produced no further output; after two settle intervals it was
  interrupted with exit `130`. Its exact log is
  `/private/tmp/sdt-g67-w142-gates/g30.log`.
- `npm run test:g32` emitted 10 files/50 tests and mutation rows, then did not
  return. Its preserved log
  `/private/tmp/sdt-g67-w142-gates/g32.log` records the subsequent
  `SekibanParity.csproj` NuGet `NU1900`/permission failures against the
  user-local NuGet cache and the node runner tail. The G32 process was not
  re-run or weakened.

The workflow's `npm run build` step was not run because it invokes Wrangler
(`wrangler deploy --dry-run`); this task expressly forbids Wrangler and
Cloudflare calls. The non-Wrangler local-e2e contract lanes listed above were
run. No timeout, assertion, scheduler expectation, or CI gate was changed.

## Boundaries and next step

The W142 arm receipts remain authoritative: true parent is
`868f2fc63bb02fb2c127e750c1d22516cc0fcff6`, candidate evidence is
`8e8f13d9cb14d547193dc642d9038e5b80d7444a`, and discarded `f5b2212` was
identity-only, not baseline evidence. No deployed acceptance claim is made
here. A later authorized continuation must apply migration `0011` to the
existing permitted arm, verify durable kick lifecycle rows and trigger
provenance, and run the required fresh matched cohort. This checkpoint does
not open a PR, deploy, touch production, or invoke a worker transition.

The child issue claim command was attempted before editing and returned the
existing `claim.stale.already-in-progress` condition; no claim mutation was
performed.


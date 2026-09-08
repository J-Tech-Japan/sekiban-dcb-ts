# SDT-G69 PR136 G67 hot-path repair — W167

Status: repair pushed locally; exact-head hosted CI must settle before rereview.

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: #136
- Branch: `claude/sdt-g69-local-ordering-proof-w164`
- Starting exact head: `946ffe6b51d4e6a1222ca07a5cd1b9097d3d7dc0`
- W167 source repair commit: `1cc6ed9`
- Scope: G69 diagnostic hot path only. No Wrangler, Cloudflare, deployment,
  production, resource, G32, PR review, merge, closeout, or issue-claim action
  was performed.

## Causal finding

The hosted G44 failure at run `34180400842`, job `101918145407`, was the
unchanged G67 AC3 guard at `test/g67-safe-lane.spec.ts:731`: the cron-disabled
paced test exceeded its unchanged 5,000 ms timeout. The G69 range was causal.
Before W167, `recordDeliveryCore` awaited an admission-mutation diagnostic
pre-read, and the late-lower detector materialized a full lower-SUID result set
and issued per-row event lookups. These were diagnostic operations, but they
ran on the delivery path and could consume the G67 response/safe-lane budget.

## Bounded repair

1. Core admission no longer starts or awaits the diagnostic pre-read. Durable
   admission returns first; the post-admission receipt runs best effort through
   the invocation `waitUntil` lifetime (or a detached promise in local tests).
   It records nullable post-admission mutation evidence,
   `diagnostic_duration_ms`, and honest `stored`/`duplicate`/`failed` or
   `unverified` labels. Retention remains bounded to 512 rows per service.
   This receipt is diagnostic only and provides no allocation closure.
2. `findLateLowerSuidEvidence` now uses bounded `LIMIT 1` proven, unknown and
   replay probes, in proven-first order, followed by at most one event lookup.
   `MaterializedViewCatchUp` calls it once before the catch-up event loop per
   pass, not once per event, and persists the measured
   `lateLowerQueryDurationMs` in `catch_up_result_json`.
3. No G67 assertion, 5,000 ms budget, timeout, scheduler, fence, SafeWindow,
   retry, drain, G44/G62 certification, first-arrival-fence decision or Queue
   semantics changed. AC4/AC5 remain outstanding; issue #133 remains open.

## Measured local cost and guards

The focused six-test G69 suite observed `diagnosticDurationMs=1 ms`,
`detectorCalls=1` for the two-event follow-up pass, and
`lateLowerQueryDurationMs=1 ms`; the real allocator-to-Tag ordering proof also
reported `[0,0] ms`. These are local observed clocks, not production latency
or allocation-closure guarantees.

The new detector guard fails if the detector is called per event: the follow-up
pass advanced two events with exactly one detector call. The existing G69
red-capable suite remains green with all four mutants red:

- omitted late-lower detector;
- restored higher-SUID lag exclusion;
- omitted append-only admission receipt;
- awaited diagnostic receipt on the core path.

## Verification

All commands below were run after the W167 fixture correction and before this
receipt was written:

- `npx vitest run test/g69-ordering.spec.ts --pool=forks --maxWorkers=1
  --no-file-parallelism`: 1 file, 6/6 passed; the NOSENTRY SQLite alarm and
  nonempty local Hyperdrive messages were environment diagnostics only.
- `npm run test:g69`: passed; four G69 mutation probes exited red as expected.
- `npm run test:g67`: passed unchanged: 11/11 behavior tests, with all seven
  G67 mutation probes red as expected. The prior exact-head 5,000 ms timeout
  is preserved as the causal pre-repair receipt; no gate was relaxed.
- `npm run test:g44`: passed: 8/8 tests and all four G44 production mutants
  red.
- `npm run test:g60:required`: passed: direct 14/14, unsafe-writer 4/4,
  Queue/durable-hop/post-admission guards green, with all six unchanged G60
  mutants red.
- `npm run test:g65`: passed: 17/17 tests, G65 guards green and their
  required red mutation/oracle evidence retained.
- `npm run typecheck`: passed.
- `npm run lint`: passed with `--max-warnings=0`.
- `git diff --check`: passed for the scoped diff.

The known G43 AC6 failure and prior G30/G32 runner/environment exceptions are
not reclassified by this repair. The structural W164 allocator witness remains
qualified local evidence, not a production incident or an allocation-order
proof. No deployed cohort was run; AC4/AC5 and exact-head hosted CI remain
required before rereview.

The source repair is committed at `1cc6ed9`; the containing evidence commit
and exact terminal CI result are supplied in the canonical handoff after push.

# SDT-G67 PR #132 F1/F2 repair — W150

Status: local repair checkpoint; no Wrangler, Cloudflare, deployment, resource,
review, merge, or closeout action was performed.

## Identity and scope

- PR: `J-Tech-Japan/sekiban-dcb-ts#132`
- Branch: `claude/sdt-g67-local-wake-w142`
- Starting PR head: `b09ea3f8b541205e5d528cc4ed4b56d7cff030a1`
- Local repair commit: `47e496d459b56aa5e690eef59009c5c6f571b2bd`
- Review: `5126339787`
- Scope: F1 applying-pass evidence publication and F2 cron-first coverage
  freshness only; F3/F4 remain intact.
- Cloudflare boundary: no deployment or configuration change; the missing
  deployed F1 cohort remains a later operational obligation.

## Findings and repair

### F1 — stale W146 acceptance attribution is superseded

The retained W146 rows do not contain the event-level fields needed to prove
that the selected pass applied the sampled event. The former
`started_at - scheduled_at` value can select a non-applying pass, so the old
`1608 ms` scheduling claim is now explicitly historical and invalidated as an
AC4 gate. The retained `16983 ms` pass value is documented as a composite
observation and is not interpreted as an unproven pre-pass Queue/fence wait.

The existing source-side repair still records exact applied-event details
(`suid`, observed `lastArrivedAt`, derived `fenceEligibleAt`, and observed
`appliedAt`). This checkpoint does not fabricate those fields into W146: no
deployed cohort with the corrected event-to-applying-pass join was run. The
deployed F1 gate is therefore incomplete, and the next deployed continuation
must publish a per-event fence-eligibility-to-actual-applying-pass join.

`docs/SDT-G67-evidence.md` now removes the stale “owned gate passed” wording,
marks the old selection invalid, and preserves the raw W145/W146 measurements
as historical attribution.

### F2 — coalesced delivery uses its own fresh pass context

The defect was in `scheduleMeetingRoomSafeLaneKick`: the scheduler callback
was created by the first request and captured that request's `pass` callback.
Cron passes capture the cron scan's `coverage`; a delivery coalescing behind
an active cron pass therefore ran the cron callback and reused stale coverage.

Each in-memory `SafeLaneKickRequest` now carries its own `runPass` callback.
The single-flight runner invokes `request.runPass(request)`, so a later
delivery executes its fresh-reconciliation callback while a later cron request
retains its cron-specific coverage context. The callback is explicitly not
serialized into the durable ledger. One active pass, latest-request
coalescing, Queue notification-only behavior, G44 frontier fencing, and cron
backstop semantics are unchanged.

The focused oracle runs both orderings with a held first pass:

```text
cron:cron-snapshot -> delivery:fresh-delivery
delivery:fresh-delivery -> cron:cron-snapshot
maximum active passes: 1; pass count per ordering: 2
```

This is a real scheduler concurrency oracle, not a source-only assertion: the
two pass callbacks carry distinct coverage contexts and the observed second
pass must use the context of the coalesced request.

## Red/green evidence

- `npm run test:g67`: passed, 11/11 focused tests; guard self-test passed;
  red-before-green receipt passed; all seven existing G67 mutants remained
  red. The six pre-existing SDT-G60 mutants were not changed.
- `node ./node_modules/vitest/vitest.mjs run --config vitest.config.ts
  --no-cache --maxWorkers=1 test/g67-safe-lane.spec.ts --testNamePattern
  'AC1: cron and Queue kicks share one effective single-flight scheduler'`:
  passed, 1/1.
- `SDT_G67_FORCE_FAILURE=1 npm run test:g67:forced-red`: exited `1` at the
  forced-red assertion after the underlying 11/11 G67 run passed, as required.
- Updated red/green/mutant receipts remain in `test/fixtures/g67-*.json`.

## Local verification

Passed after the repair:

```text
npm run test:g44
npm run test:g58
npm run test:g62
npm run test:g60:required
npm run test:g61
npm run test:g65:required
npm run typecheck
npm run lint
npm run test:store-contract
npm run test:d1
npm run test:mv
npm run test:cosmos-wiring
npm run test:boundaries
npm run test:consumer
npm run test:g20
npm run test:g20:gate
npm run test:g25
npm run test:g26
npm run test:g27
npm run test:g28
npm run test:g29:domain-source
npm run test:g29:authoring-doc
npm run test:g29:mapping
npm run test:g29:delivery
npm run test:g29:diagnostics
npm run test:g29:compatibility
npm run test:g29:sample
npm run test:g31
npm run test:g26:topology
npm run test:g20:candidate
npm run test:g29:candidate
npm run test:g31:candidate
npm run test:g32:candidate
npm run test:g37:evidence
npm run test:g42
npm run test:g45
npm run test:g46
npm run test:g49
npm run test:g41
npm run test:g51
npm run test:g30:candidate
```

The first plain `npm run check` stopped at `test:g28:boundaries` because npm
could not write `/Users/tomohisa/.npm/_logs`. The same full check was rerun
with `NPM_CONFIG_CACHE=/private/tmp/sdt-g67-w150-npm-cache`; it reached the
aggregate `npm test` and recorded these pre-existing parallel-pool failures:

```text
test/commit.spec.ts AC7 — 5000 ms timeout
test/g43-tag-sql.spec.ts AC6 — waitForConfiguredAlarm returned null
test/g67-safe-lane.spec.ts AC3 — 5000 ms timeout in the full pool
test/repair.spec.ts — two existing timeout failures (5000 ms and 15000 ms)
test/tag.spec.ts G5 — 5000 ms timeout
```

The aggregate reported 5 failed files, 6 failed tests, 771 passed, and 1
skipped. The isolated G67 lane above passed. No timeout, assertion, fixture,
scheduler expectation, or gate was weakened. The post-check continuation ran
the commands listed above individually; all passed.

`npm run test:g32` completed its 10-file/50-test parity portion and emitted
the full mutation inventory, then produced no further output and was stopped
with exit `130` after the bounded runner wait. `npm run test:g30` likewise
emitted its trace/B0/manifest and mutation receipts, then was stopped with
exit `130` after the bounded runner wait. These are environment/runner
exceptions, not green results. G46 completed its 31-test and mutation lane;
G51 and G30 candidate checks passed.

`git diff --check` passed. Existing unrelated dirty and untracked G58/G61/G62/
G65/W145 artifacts were preserved and not staged.

## Remaining obligation

F2 is locally repaired and guarded. F1 source instrumentation is present, but
the W146 raw receipt cannot prove the required per-event applying-pass join.
Do not claim deployed AC4 completion from this checkpoint; a later authorized
deployed cohort must provide the corrected attribution before acceptance.

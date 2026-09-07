# SDT-G67 PR #132 review repair — W149

Status: completed local repair checkpoint; no deployment or Cloudflare operation.

## Identity and handoff

- Existing branch: `claude/sdt-g67-local-wake-w142`
- Reviewed starting head: `61c95675e05d82091a126e944063d77e9eda0af7`
- Pushed repair head: `b4ccd72147716fd5089fc4a9718b7c66fc9b978f`
- PR: J-Tech-Japan/sekiban-dcb-ts#132
- Existing PR claim was applied before editing with:
  `intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind pr --number 132 --github-only --write --format json`
- No Wrangler, Cloudflare, deployment, resource, review, merge, or closeout operation was run.

The repair commit is narrow and contains only the G67 evidence/instrumentation,
shared cron-scheduler integration, affected G31/G58 source-anchor maintenance,
G67 tests/fixtures, and `docs/SDT-G67-evidence.md`. Existing unrelated dirty
and untracked W145/G58/G61/G62/G65 evidence remains unstaged.

## Finding and repair mapping

### F1 — scheduling attribution is event/apply-specific

The old W146 attribution selected `started_at - scheduled_at` and could select
a delivery-owned or fence-expiry row that did not apply the sampled event. The
repair adds `appliedEventDetails` to the existing safe-lane catch-up observation
and populates it from the real materialized-view `afterApply` hook. Each detail
contains the exact event SUID, observed `lastArrivedAt`, derived
`fenceEligibleAt = lastArrivedAt + safeWindowMs`, and observed `appliedAt`.
The later runner must join a sample to the pass containing its exact applied
SUID; no non-applying pass or `scheduled_at` interval is presented as proof.
The retained W146 receipts do not contain this event-level field, so W149 does
not invent corrected deployed timing; a later cohort is required for repaired
deployed attribution.

### F2 — cron enters the same single-flight scheduler

The runtime scheduled hook now forwards its real `ExecutionContext`. The meeting
room cron hook calls `scheduleMeetingRoomSafeLaneKick` with `trigger="cron"`
and the same pass callback used by delivery/fence-expiry triggers. It no longer
calls the safe-lane pass body directly. The scheduler retains one active pass
per service and one coalesced rerun. The focused concurrent oracle observed
maximum active passes `1`, pass count `2`, and identical final heads. The
`cron-bypasses-single-flight-scheduler` mutation is red.

### F3 — genuine cron-disabled public-path proof

The AC3 oracle now uses the real serialized public commit endpoint through the
test Worker, real Tag Durable Objects and Tag outbox rows, the real
`handleDownstreamQueue`/`recordDelivery` path, the shared safe-lane scheduler,
and the public safe list reader. It performs ten distinct commits with cron
disabled and records each returned event SUID, observed commit/delivery/safe
clocks, and public safe head. A deterministic logical clock advances between
commits so this is a causal local path proof, not a deployed latency claim.
The old synthetic callback/head injection is no longer the AC3 oracle. The
omitted-kick mutation is red.

### F4 — deployed receiver documentation is exact

The retained W146 deployed version view is documented as:

- `DIRECT_DOORBELL=false`
- `DIRECT_DOORBELL_RECEIVER_MODE="separate"`
- no `DOWNSTREAM_DOORBELL` service binding

The previous “absent/unconfigured” wording is superseded. No W149 deployment
was performed and no new deployed identity is claimed.

## Red/green evidence

- `test/fixtures/g67-red-before-green.json`: red-before-green receipt.
- `test/fixtures/g67-green.json`: focused green receipt.
- `test/fixtures/g67-mutants-red.json`: all seven mutations red:
  omitted event-driven kick, cron scheduler bypass, reused coalesced owner,
  BLOCK/frontier advancement, awaited Queue hook, omitted effective catch-up,
  and omitted fence-expiry trigger.
- `node scripts/g67-safe-lane-guard.mjs --self-test` passed.
- `node scripts/g67-safe-lane-guard.mjs --pre-fix` produced the required red
  receipt; `node scripts/g67-safe-lane-guard.mjs` passed with all seven mutant
  rows red.

## Local gates

Focused and directly affected lanes passed:

```text
npx vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/g67-safe-lane.spec.ts — 11 tests passed
npm run test:g67 — passed; green, red-before-green, and seven-mutant receipts
npm run test:g67:forced-red — passed its normal lane and forced-red wiring
npm run test:g31 — 33 tests passed
npm run test:g44 — 8 tests passed; G44 mutants red
npm run test:g58 — 15 tests passed; G58 guards/mutants green/red
npm run test:g60:required — passed; six G60 mutants red
npm run test:g61 — passed; guard and mutant red
npm run test:g62 — passed; three mutations red
npm run test:g65:required — 17 tests passed; G65 guards/mutants red
npm run typecheck — passed
npm run lint — passed
```

The broader local workflow lanes also passed: G21, G22, G23, G24, G25, G26,
G27, G28, G29 mapping/delivery/diagnostics/compatibility/domain-source/
authoring-doc/sample/witness/candidate, G37 evidence, G38 prep, G41, G42,
G43, G45, G46, G49, G51, G53, G54, G55, G56, G20/gate/candidate, G16, G17,
G17 rollout-order, store-contract, D1, MV, boundaries, consumer, and the
G28 compile-fail/source/negative/package gates. The first two default-cache
G28 package-boundary attempts failed only because npm could not write
`/Users/tomohisa/.npm/_logs`; retries with
`NPM_CONFIG_CACHE=/private/tmp/sdt-g67-w149-npm-cache` passed.

The exact aggregate `npm test` exited non-zero with 4 five-second timeouts
among 778 tests (773 passed, 1 skipped): existing `test/commit.spec.ts` AC7,
existing `test/tag.spec.ts` G5, existing `test/repair.spec.ts` checkpoint, and
the new G67 AC3 test in the full parallel pool. The G67 file passes in the
isolated focused lane. No timeout or assertion was changed; this is recorded
as a local parallel-runner exception rather than a green aggregate.

The exact `npm run test:g30` lane produced its schema/B0/manifest and mutation
receipts, then emitted no output for about 90 seconds and was terminated with
Ctrl-C, exit `130`. The exact `npm run test:g32` lane passed its 10-file/50-test
Vitest portion and initial mutation output, then emitted no output for about 90
seconds and was terminated with Ctrl-C, exit `130`. These are runner
exceptions. The interrupted G30 mutation left a temporary trace source edit;
the source was restored and rechecked clean before the repair commit.

Workflow steps that invoke `wrangler deploy` or a Wrangler local E2E were not
run because this task forbids deployment and Cloudflare operations. No source
gate was weakened to compensate for those scope exclusions.

## Changed-file scope

```text
docs/SDT-G67-evidence.md
packages/dcb-runtime/src/cloudflare.ts
samples/meeting-room/src/d1-mv.ts
samples/meeting-room/src/worker.cloudflare-only.ts
scripts/g58-block-live-green-guard.mjs
scripts/g58-live-poll-diagnosis-guard.mjs
scripts/g58-reservation-safe-starvation-guard.mjs
scripts/g58-safe-live-starvation-guard.mjs
scripts/g67-safe-lane-guard.mjs
test/g31-sample.spec.ts
test/g67-safe-lane.spec.ts
test/fixtures/g67-green.json
test/fixtures/g67-mutants-red.json
test/fixtures/g67-red-before-green.json
```

`git diff --cached --check` passed before commit. The final repair commit was
pushed to the existing PR branch at `b4ccd72147716fd5089fc4a9718b7c66fc9b978f`.

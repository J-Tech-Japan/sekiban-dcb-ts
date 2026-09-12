# SDT-G80 — deterministic G67 budget calibration

Task: `SDT-G80-IMPLEMENTATION-W268`
Issue: [#162](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/162)
PR: [#174](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/174)

## Scope and provenance

This repair continues the existing dedicated branch
`claude/sdt-g80-implementation-w264` from base
`e0988822b91ad664cfddfdb9125d0251faa5fb37`. The closed historical PR #163 and
its branch are not reused. The change is limited to the G80 mutation runner,
its structured Vitest receipt reporter, a sanitized historical receipt fixture,
and this evidence document. Product source, the checked-in G67 AC3 body and
budget, G73 guard semantics, G71, G74, G77, G78, workflows, and unrelated lanes
remain out of scope.

Whole-test `signedDifferenceMs` is retained only as attribution data. It is not
compared with a per-round allowance and cannot select representative work.
Representative sizing uses the conservative direct per-round lower bound, with
the unchanged `safetyFactor: 1.5` and `maxRepresentativeRounds: 4096`.

## AC1 — observation-only baseline and historical receipts

The pre-G80 runner hash recorded by observation-only mode is
`74e024444725c5aa01f01b8e1346b5329099e9c60135babd66186a11e1c3d7ee`. Its legacy
whole-test subtraction and one-millisecond clamp remain available only under
`--observation-only`; normal calibration never uses that estimator. The mode
retains each subprocess JSON report and structured receipt under
`.artifacts/sdt-g80-observation/` and emits healthy and calibration inputs before
any estimator branch. A local invocation cannot establish separate hosted job
instances.

The issue's five fresh legacy pairs remain `0/5`, superseded by the design
ruling, and are not relabelled as collected by this branch. The known historical
receipts remain distinct and make no causal claim about the old 4,742 result:

| source | observed result | disposition |
| --- | --- | --- |
| main `809d535ee93e2318b46234db47ffb2d94b1949a1`, workflow `34418417311`, job `102688333944` | healthy `3,230` ms; 32-round calibration `4,681` ms; difference `1,451` ms; 224 rounds passed at `8,163` ms and 336 rounds timed out at `10,006` ms | historical legacy receipt |
| main `193cfa44563d08ffadef146c4eca769098044be1`, workflow `34465922635`, job `102834361879` | legacy runner reported representative estimate `4,742` and stopped before emitting a raw pair | historical failure; raw cause not established |
| G71 PR #161, head `565625c0a48bf64d24dd0db6d1be25af6ef8819f`, workflow `34473938826`, job `102878368630` | healthy `2,860` ms; calibration `3,460` ms; difference `600` ms; 572 rounds timed out at `10,145` ms | historical cross-branch receipt |

## W226 historical parser failure

Run [34509483454](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454)
at the historical W226 head `4cefc3f5` is retained as a red receipt. Its
ci-foundation failure stopped in the unchanged G67/G73 runner after self-tests;
ci-g46 separately had the `read.spec.ts:338` assertion failure. W268 does not
rerun or reclassify either receipt. The later W226 parser repair established
that SGR stripping was required; the structured receipt work here is separate.

## AC2 — direct real-work timing contract

The normal mutation measures the real injected G69 path in the G67 test body.
It keeps the single-first-commit boundary, creates two complete unique
`g32Message` deliveries per round, calls the real `D1EventStore`, and awaits
every diagnostic waiter after each `recordDelivery`. One-time store
initialization is measured separately. No timer, `Date.now()`,
`process.hrtime`, enqueue-only shortcut, or synthetic delay is used.

The predeclared direct plan is unchanged:

```text
chunks:              [4, 8, 12, 4, 4] rounds
total calibration:   32 rounds
operations/round:    2 complete deliveries
direct work:         64 deliveries, 64 drained waiter sets
elapsed ceiling:     5,000 ms
clock:               performance.now() inside the Vitest body
clock validation:    3 samples, 32 real D1 SELECT 1 queries per sample
cross-size bound:    [0.5 × median, 2 × median]
equal-size residual: 10 ms/round maximum
```

The `performance.now()` clock is accepted only after positive finite D1 probe
advancement, monotonicity, separated initialization, exact operation/delivery
counts, and drained waiters are present. Direct chunk rates, cross-size bounds,
and equal-size residuals are the authoritative uncertainty inputs. Whole-test
duration differences remain attribution-only diagnostics.

## W264/W266 historical direct evidence

The following W264 receipts are historical and are retained without promoting
them to W268 observations. They are useful for the accepted direct decision:

| source | direct raw values | decision |
| --- | --- | --- |
| W264 hosted pair, repaired runner | chunks `[4, 8, 12, 4, 4]`; durations `[104, 148, 338, 68, 81]` ms; rates `[26, 18.5, 28.166666666666668, 17, 20.25]`; median `20.25`; observed range `17..28.166666666666668`; cross-size bounds `10.125..40.5`; residuals `[9, 5.75, 3.25]`; residual max `9`; allowance `13.25`; lower bound `17` | accepted because `17 > 13.25`; healthy/calibration bodies `631`/`583` ms and signed delta `-48` ms are attribution-only |
| W264 local mechanism proof | chunk durations `[27, 54, 67, 21, 25]` ms; rates `[6.75, 6.75, 5.583333333333333, 5.25, 6.25]`; median `6.25`; bounds `3.125..12.5`; residuals `[1.5, 0.5, 1]`; allowance `2.5`; lower bound `5.25`; healthy/calibration bodies `776`/`1075` ms; signed delta `299` ms | accepted because `5.25 > 2.5`; local mechanism evidence only |
| W266 local focused proof | healthy `1648` ms; calibration `2783` ms; direct rates `[14.5, 15.125, 16.166666666666668, 12, 13.5]`; median `14.5`; bounds `7.25..29`; residuals `[2.5, 1, 1.5]`; allowance `3`; lower bound `12`; predicted 32-round work `384` ms; signed delta `1135` ms | accepted because `12 > 3`; 1044-round representative reached `15179` ms and timed out; local mechanism evidence only |

W266's retained hosted job-level observations all used immutable source head
`fbca111fbee368c8248a0d0634591565943e0321` and are preserved below. Attempt 3
is a real `CALIBRATION_INCONCLUSIVE` boundary failure, not a flake and not
replaced. Its old receipt did not carry every raw direct field; W268's failure
path is the repair for that evidence gap.

| workflow / attempt / job | result and raw full-precision values |
| --- | --- |
| [34704762453 attempt 2 / job 103584804293](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34704762453/job/103584804293) | success; elapsed `7m41s`; healthy `3266` ms; calibration `4082` ms; signed delta `816` ms (attribution only); rates `[23.5, 23.375, 20.083333333333332, 20, 19.75]`; lower bound `19.75`; median `20.083333333333332`; allowance `4.25`; bounds `10.041666666666666..40.166666666666664`; residuals `[3.5, 3.75, 0.25]`; predicted work `632` ms; attribution ratio `1.2911392405063291`; representative `512` timed out at censored body `11384` ms |
| [34704762453 attempt 3 / job 103585936144](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34704762453/job/103585936144) | retained failure; elapsed `6m23s`; healthy `2859` ms; calibration `3692` ms; signed delta `833` ms (attribution only); rates `[28, 19.125, 17.666666666666668, 18, 17.5]`; residuals `[10, 10.5, 0.5]`; range `0.5..10.5` exceeded the predeclared `10` bound, so `CALIBRATION_INCONCLUSIVE`; representative not reached in that historical receipt |
| [34704762453 attempt 4 / job 103586916628](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34704762453/job/103586916628) | success; elapsed `8m54s`; healthy `3293` ms; calibration `4249` ms; signed delta `956` ms (attribution only); rates `[24.75, 22.875, 21.083333333333332, 20.75, 19.25]`; lower bound `19.25`; median `21.083333333333332`; allowance `8.5`; bounds `10.541666666666666..42.166666666666664`; residuals `[4, 5.5, 1.5]`; predicted work `616` ms; attribution ratio `1.551948051948052`; representative `523` timed out at censored body `11426` ms |

## AC3 — fail-closed state and failure receipts

Every normal invocation emits a structured stage record before validation or
branching for `healthy`, `calibration`, `estimate`, and every representative
attempt. Each stage carries process status, signal/spawn error, JSON/report
target, structured receipt target and errors, final status, Vitest version,
direct timing marker/error, raw output, and applicable body timings. A
calibration failure additionally carries the raw direct timing record (or its
absence), clock validation, separated initialization, chunk costs, uncertainty
inputs, signed whole-test attribution, `representativeSelection:
"not-reached"`, `attempts: []`, and `semanticTimeout: "not-reached"`.

The representative classifier has exactly two advancing states: an exact
named-target pass may escalate, and an exact named-target timeout completes
the proof. Signal termination, missing or malformed report/receipt/version,
setup/collection failure, unhandled error, skipped or duplicate target,
assertion failure, and every unknown state stop immediately as
`HEALTHY_OR_ORACLE_FAILURE` with attempts accumulated so far. No 1.5× escalation
occurs after any such result.

## AC4 — pinned structured timeout oracle

The runner now exposes `receiptVitestVersion` and
`installedVitestVersion` from every invocation and accepts either only when
both equal pinned Vitest `4.1.10`. A missing, malformed, or different version
fails closed. `requireTimeoutRegression` accepts only one failed exact target,
one exact first-line message `Test timed out in 10000ms.`, normal nonzero exit,
no signal/spawn error, no other failed test, no collection/unhandled error, a
finite body duration at least the budget, and a complete pinned-version
receipt. It never uses combined output as a timeout oracle.

The committed sanitized fixture
[`scripts/fixtures/g80-w226-stack-trace-error.json`](../scripts/fixtures/g80-w226-stack-trace-error.json)
retains the W226 `STACK_TRACE_ERROR` shape. It is explicitly rejected because
the stack is not the timeout message. The table-driven self-test also rejects:

| negative shape | required disposition |
| --- | --- |
| hook timeout | `HEALTHY_OR_ORACLE_FAILURE`; `Hook timed out...` is not a body timeout |
| selected-target assertion | reject exact target with assertion error |
| mixed timeout and assertion messages | reject more than one target error |
| other failed target | reject any additional failed test |
| duplicate selected target | reject ambiguous target count |
| output-only fabricated timeout | reject without a structured receipt target |
| sanitized W226 `STACK_TRACE_ERROR` | reject stack-only evidence |
| signal, setup/collection, unhandled, missing target, green target, wrong timeout, missing/wrong Vitest version, incomplete process/spawn error | reject fail-closed |

The self-test retains the actual 10 ms Vitest timeout conformance case, healthy
control, ANSI/truncated/missing marker checks, unit-mismatch mutant, direct
signal mutant, both cross-size mutants, equal-size residual mutant, and
immediate-stop representative simulation. The reporter fixture and source-shape
proof remain G67-only and are restored after mutation.

## AC5 — unchanged safety boundary

`test/g67-safe-lane.spec.ts` remains byte-identical to the base. Its 33
obligations, SQL pending selection of 32, first-send cardinality 32,
non-null re-arm, acknowledgement of 32, second-send cardinality 33, zero
pending findings, final null alarm, and 10,000 ms budget remain unchanged.
`maxRepresentativeRounds` remains 4096, `safetyFactor` remains 1.5, and
`SDT_G79_HOSTED_MEASURE` remains enabled for acceptance. No product behavior,
workflow, timeout, retry, skip, or unrelated lane was changed.

## W268 staged proof plan — predeclared before fresh measurements

The first W268 push contains the runner/reporter/fixture implementation and
this predeclared skeleton. The implementation-source and lockfile head for
measurement will be recorded after that push; no W268 measurement value is
claimed before the ordinary exact-head PR checks for that head are green.

After ordinary PR CI is green, exactly three job-level reruns of the same
successful `ci-foundation` job at that immutable implementation-source and
lockfile head are authorized. They are predeclared as observations 1, 2 and 3,
at about eight billable minutes per job. Every result, including a failure, is
retained. No workflow dispatch, replacement run, unrelated job, or retry-until-
green is authorized. The evidence-only commit may change this document and the
PR description only; it must not change the runner, reporter, fixture or
lockfile. Its ordinary exact-head PR CI runs once and does not repeat the three
observations.

### W268 measurement receipt table (pending first staged proof)

| observation | source/lockfile head | workflow attempt / job | outcome | full-precision values and cost |
| --- | --- | --- | --- | --- |
| 1 | pending ordinary-CI-green implementation head | pending | not collected | predeclared; no value claimed |
| 2 | same immutable head as observation 1 | pending | not collected | predeclared; no value claimed |
| 3 | same immutable head as observation 1 | pending | not collected | predeclared; no value claimed |

The final W268 section will replace only the pending cells with exact receipts,
raw full-precision fields, and per-run cost; it will retain this predeclared
plan, all historical tables above, and the byte-identity comparison between
measurement and evidence-only heads.

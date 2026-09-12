# SDT-G80 — deterministic G67 budget calibration

Task: `SDT-G80-IMPLEMENTATION-W268`
Issue: [#162](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/162)
PR: [#174](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/174)

## Scope and provenance

This repair continues the existing dedicated branch
`claude/sdt-g80-implementation-w264` from base
`e0988822b91ad664cfddfdb9125d0251faa5fb37`. The closed historical PR #163 and
its branch are not reused. The G80 change is limited to the mutation runner
`scripts/g73-g67-budget-mutation-runner.mjs`, the G80 receipt reporter
`scripts/g80-vitest-receipt-reporter.mjs`, a sanitized historical receipt
fixture, and this evidence document. Product source, the checked-in G67 AC3
body and budget, G73 guard semantics, G71, G74, G77, G78, workflows, and
unrelated lanes remain out of scope. The separate G79 hosted reporter is not a
G80 component and is not part of the G80 evidence claim.

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
attempt. Each stage carries process status, signal/spawn error, compact
JSON/report target and receipt target/error facts, final status, Vitest version,
direct timing marker/error, and applicable body timings. Captured child output
is intentionally excluded from durable records; bounded target/error fields,
stable stage references, and digests preserve the required evidence without
duplicating verbose reports. A calibration failure additionally carries the
raw direct timing record (or its absence), clock validation, separated
initialization, chunk costs, uncertainty inputs, signed whole-test attribution,
`representativeSelection: "not-reached"`, `attempts: []`, and
`semanticTimeout: "not-reached"`.

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

The first W268 push contains the G80 runner/receipt-reporter/fixture implementation and
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

### W268 measurement receipts — implementation-source head

The implementation-source head is
`2c40420a1c3d6c50b04b74a7a45cc43c1b8e19e3`; `package-lock.json` was unchanged
and its blob is `e611de40b6c7423faebd8325e8ba45f870681d5f`. Ordinary PR CI was
green before measurement: [workflow 34709546015](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34709546015),
attempt 1, with foundation `103595650118`, cheap `103595650332`, and verify
`103597666718` successful. Exactly the following predeclared job-level
observations were then collected from that successful foundation job. Every
observation used the same implementation source/lockfile head, Linux, Node
`v24.20.0`, and installed/receipt Vitest `4.1.10`.

| observation | workflow attempt / exact foundation job | hosted interval | result and cost |
| --- | --- | --- | --- |
| 1 | [34709546015 attempt 2 / 103597812538](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34709546015/job/103597812538) | `2026-09-12T18:09:19Z`–`2026-09-12T18:16:48Z` (`7m29s`) | success; about 8 billable minutes |
| 2 | [34709546015 attempt 3 / 103599199329](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34709546015/job/103599199329) | `2026-09-12T18:19:19Z`–`2026-09-12T18:27:06Z` (`7m47s`) | success; about 8 billable minutes |
| 3 | [34709546015 attempt 4 / 103600351190](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34709546015/job/103600351190) | `2026-09-12T18:27:47Z`–`2026-09-12T18:35:32Z` (`7m45s`) | success; about 8 billable minutes |

These are all retained results, not replacements or retry-until-green runs;
the three job-level observations cost about 24 billable minutes in aggregate.
Their verify jobs were also successful: `103598860958` (attempt 2),
`103600265116` (attempt 3), and `103601409619` (attempt 4). The reporter's
`sourceSha` `1625eb96fe730a53238daf033b1f83087d67198c` is the generated
mutated-source digest, not the repository commit SHA.

#### Raw direct timing and decisions

Observation 1 healthy was process `0`, receipt `passed`, body `2991` ms,
process elapsed `9338` ms, with expected direct-marker absence. Calibration was
process `0`, receipt `passed`, body `3938` ms, process elapsed `10266` ms,
receipt/installed version `4.1.10`/`4.1.10`:

```text
clock=performance.now; clockValidation={probeQuery:"D1 SELECT 1",samples:3,queriesPerSample:32,minAdvanceMs:29,maxAdvanceMs:31,monotonic:true}; initializationMs=2; initializationSeparated=true
chunks=[{rounds:4,operations:8,deliveryCount:8,durationMs:89,waitersDrained:true},{rounds:8,operations:16,deliveryCount:16,durationMs:169,waitersDrained:true},{rounds:12,operations:24,deliveryCount:24,durationMs:233,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:78,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:77,waitersDrained:true}]; totalRounds=32; operationsPerRound=2; deliveryCount=64; waitersDrained=true; skippedDeliveries=0; omittedWaiterDrain=false; wrongCount=false; timerOnly=false; clockAdvancesDuringRealWork=true; minObservedAdvanceMs=77
```

Its raw summary was `signedDifferenceMs=947` (whole-test attribution only),
`directPerRoundMs=19.25`, `directRateLowerBoundMs=19.25`,
`directRateMedianMs=19.5`, `predictedAddedWorkMs=616`,
`wholeTestAttributionRatio=1.5373376623376624`,
`directSignalDominatesAllowance=true`, `predictionRatio=1.5373376623376624`,
`scalingRatio=1.155844155844156`,
`crossSizeRateBounds={referenceRateMs:19.5,lowerRatio:0.5,upperRatio:2,lowerMs:9.75,upperMs:39,observedMinMs:19.25,observedMaxMs:22.25}`, and
`equalSizeResidualBoundMs=10`. The raw allowance was
`costsPerRoundMs=[22.25,21.125,19.416666666666668,19.5,19.25]`,
`pairedResidualsMs=[2.75,3,0.25]`, residual range `0.25..3`,
`madMs=0.25`, `timerResolutionFloorMs=1`, `allowanceMadFactor=3`,
`allowanceMs=3.5`. The exact named target selected `547` representative
rounds from the conservative direct lower bound, then the exact timeout proof
was `regressionBodyMs=10073`, `regressionOverBudgetMs=73`, process `1`, signal
`null`, target count `1`, receipt-target count `1`, first line
`Test timed out in 10000ms.`; final result was
`healthy-green-g69-path-timeout-red`.

Observation 2 healthy was process `0`, receipt `passed`, body `3396` ms,
process elapsed `9727` ms. Calibration was process `0`, receipt `passed`, body
`4096` ms, process elapsed `10505` ms, versions `4.1.10`/`4.1.10`:

```text
clock=performance.now; clockValidation={probeQuery:"D1 SELECT 1",samples:3,queriesPerSample:32,minAdvanceMs:33,maxAdvanceMs:36,monotonic:true}; initializationMs=2; initializationSeparated=true
chunks=[{rounds:4,operations:8,deliveryCount:8,durationMs:99,waitersDrained:true},{rounds:8,operations:16,deliveryCount:16,durationMs:183,waitersDrained:true},{rounds:12,operations:24,deliveryCount:24,durationMs:246,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:84,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:77,waitersDrained:true}]; totalRounds=32; operationsPerRound=2; deliveryCount=64; waitersDrained=true; skippedDeliveries=0; omittedWaiterDrain=false; wrongCount=false; timerOnly=false; clockAdvancesDuringRealWork=true; minObservedAdvanceMs=77
```

Its raw summary was `healthyMarginMs=6604`, `signedDifferenceMs=700`
(attribution only), `directPerRoundMs=19.25`, `directRateLowerBoundMs=19.25`,
`directRateMedianMs=21`, `predictedAddedWorkMs=616`,
`wholeTestAttributionRatio=1.1363636363636365`,
`directSignalDominatesAllowance=true`, `predictionRatio=1.1363636363636365`,
`scalingRatio=1.2857142857142858`,
`crossSizeRateBounds={referenceRateMs:21,lowerRatio:0.5,upperRatio:2,lowerMs:10.5,upperMs:42,observedMinMs:19.25,observedMaxMs:24.75}`, and
`equalSizeResidualBoundMs=10`. The raw allowance was
`costsPerRoundMs=[24.75,22.875,20.5,21,19.25]`,
`pairedResidualsMs=[3.75,5.5,1.75]`, residual range `1.75..5.5`,
`madMs=1.75`, `timerResolutionFloorMs=1`, `allowanceMadFactor=3`,
`allowanceMs=9`. The exact named target selected `515` representative rounds,
then timed out with `regressionBodyMs=11287`,
`regressionOverBudgetMs=1287`, process `1`, signal `null`, target count `1`,
receipt-target count `1`, and first line `Test timed out in 10000ms.`; final
result was `healthy-green-g69-path-timeout-red`.

Observation 3 healthy was process `0`, receipt `passed`, body `3453` ms,
process elapsed `9971` ms. Calibration was process `0`, receipt `passed`, body
`4436` ms, process elapsed `10916` ms, versions `4.1.10`/`4.1.10`:

```text
clock=performance.now; clockValidation={probeQuery:"D1 SELECT 1",samples:3,queriesPerSample:32,minAdvanceMs:33,maxAdvanceMs:33,monotonic:true}; initializationMs=2; initializationSeparated=true
chunks=[{rounds:4,operations:8,deliveryCount:8,durationMs:98,waitersDrained:true},{rounds:8,operations:16,deliveryCount:16,durationMs:175,waitersDrained:true},{rounds:12,operations:24,deliveryCount:24,durationMs:242,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:81,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:78,waitersDrained:true}]; totalRounds=32; operationsPerRound=2; deliveryCount=64; waitersDrained=true; skippedDeliveries=0; omittedWaiterDrain=false; wrongCount=false; timerOnly=false; clockAdvancesDuringRealWork=true; minObservedAdvanceMs=78
```

Its raw summary was `healthyMarginMs=6547`, `signedDifferenceMs=983`
(attribution only), `directPerRoundMs=19.5`, `directRateLowerBoundMs=19.5`,
`directRateMedianMs=20.25`, `predictedAddedWorkMs=624`,
`wholeTestAttributionRatio=1.5753205128205128`,
`directSignalDominatesAllowance=true`, `predictionRatio=1.5753205128205128`,
`scalingRatio=1.2564102564102564`,
`crossSizeRateBounds={referenceRateMs:20.25,lowerRatio:0.5,upperRatio:2,lowerMs:10.125,upperMs:40.5,observedMinMs:19.5,observedMaxMs:24.5}`, and
`equalSizeResidualBoundMs=10`. The raw allowance was
`costsPerRoundMs=[24.5,21.875,20.166666666666668,20.25,19.5]`,
`pairedResidualsMs=[4.25,5,0.75]`, residual range `0.75..5`,
`madMs=0.75`, `timerResolutionFloorMs=1`, `allowanceMadFactor=3`,
`allowanceMs=6.5`. The exact named target selected `504` representative rounds,
then timed out with `regressionBodyMs=10871`,
`regressionOverBudgetMs=871`, process `1`, signal `null`, target count `1`,
receipt-target count `1`, and first line `Test timed out in 10000ms.`; final
result was `healthy-green-g69-path-timeout-red`.

All three calibrations had positive validated clock advancement, separated
initialization, complete 32-round/64-delivery work, and drained waiters. No
calibration failed in these fresh observations. Representatives were selected
only after exact valid named-target passes and were accepted only by the exact
named timeout. The fail-closed failure paths emit their raw applicable fields,
`representativeSelection:"not-reached"`, `attempts:[]`, and
`semanticTimeout:"not-reached"`; the local self-tests cover those paths.

The evidence-only commit may change only this document and the PR description;
it must not change the runner, reporter, fixture, or lockfile. No fresh
foundation observation will be repeated on the evidence-only head.

## W270 — durable line-safe receipts and hosted AC6 observations

W270 repaired the durable-output gap identified by W269. The implementation
source head used for the observations is
`af7baff737b89a781850d8198881b7035a5b52b8`, on branch
`claude/sdt-g80-implementation-w264`, based on
`e0988822b91ad664cfddfdb9125d0251faa5fb37`. The G80-relevant source change is
the mutation runner `scripts/g73-g67-budget-mutation-runner.mjs`. The separate
G79 hosted reporter is outside G80, has no import or reference from the G80
subprocess path, and is restored to its base blob by W272. G80 invokes the
command-line JSON/verbose and G80 receipt reporters, which replace configured
reporters, so restoring the unrelated G79 reporter does not invalidate W270
observations. The G80 runner emits schema `sdt-g80-calibration-record-v2`
stage and summary lines bounded at 12,000 UTF-8 bytes. Each line contains
workflow/run attempt, job, source/checkout identity, stable observation/stage
identity, canonical record digest, and the compact AC6 fields. A summary
references every stage and carries a reconstruction digest; captured output
and duplicated report objects are excluded.

The local self-test passed for bounded success/failure reconstruction, digest
tampering, missing stage, unrelated output, and overlong-line rejection. The
focused `npm run test:g73:guard` invocation also retained the known W266 local
`CALIBRATION_INCONCLUSIVE` boundary where the local direct lower bound equaled
the allowance; that local result is not promoted to hosted evidence and no
calibration rule was weakened.

### Source-head ordinary CI gate and pre-declaration

Before any fresh observation, ordinary pull-request CI was green at the
immutable PR head `af7baff737b89a781850d8198881b7035a5b52b8` in [workflow
34715044250](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250),
attempt 1: foundation job
`103610674123` (19:44:34Z–19:52:27Z, 7m53s), cheap job
`103610673984` (19:44:34Z–19:59:46Z, 15m12s), and verify job
`103612595870` (19:59:49Z–19:59:58Z) all completed successfully. The
ordinary source-head CI gate is distinct from the observations below.

The pre-declaration was posted before O1 in [PR comment
5648335415](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/174#issuecomment-5648335415).
It named O1, O2 and O3 as exactly three sequential job-level reruns of the
successful `ci-foundation` job, at about eight billable minutes each, with no
replacement, whole-workflow dispatch, unrelated job, retry-until-green, or
fourth observation. Each archived log was read and independently
reconstructed before the next rerun.

GitHub reports the pull-request source `headSha` as `af7baff...` for all four
workflow attempts. The durable record metadata reports
`sourceSha`/`immutableHead` as
`935ff5dacf52fd8d601273c27c1176f348ad3611`, the actual immutable GitHub
pull-request merge-ref checkout seen by the job. These are different
identities and are recorded separately, not conflated. Every durable record
also carries workflow `34715044250`, its attempt, `ci-foundation`, Linux,
Node `v24.20.0`, and receipt/report/installed Vitest `4.1.10`.

### Observation receipts and log reconstruction

All three observations used the same implementation source and lockfile head;
all were terminal-success jobs whose exact named representative outcome was
the intended `healthy-green-g69-path-timeout-red` with disposition
`exact-named-target-timeout`. Every log contained four stage records plus one
summary record; every record-level canonical digest, stage reference, summary
reconstruction digest, and 12,000-byte line bound verified independently.
The saved local downloads were obtained with `gh run view --log` using the
isolated cache path `/private/tmp/g80-w270-gh-cache`; the linked GitHub job
pages are the durable receipts.

| observation | hosted job and verify receipt | hosted interval / cost | records and reconstruction |
| --- | --- | --- | --- |
| O1 | [attempt 2 / ci-foundation 103612773497](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250/job/103612773497); [verify 103613776337](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250/job/103613776337) | `2026-09-12T20:01:02Z`–`20:08:21Z` (`7m19s`), about 8 billable minutes | `/private/tmp/g80-w270-o1-job-103612773497.log`; 5 records; maximum line `4808` bytes; reconstruction digest `3ac74960922929bc5cd46ce6be5d037c17b0c1366298e9a4910eaaf910df9dc2`; verified |
| O2 | [attempt 3 / ci-foundation 103613981262](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250/job/103613981262); [verify 103615008802](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250/job/103615008802) | `2026-09-12T20:09:54Z`–`20:17:26Z` (`7m32s`), about 8 billable minutes | `/private/tmp/g80-w270-o2-job-103613981262.log`; 5 records; maximum line `4712` bytes; reconstruction digest `62f312ddbf963e2e577be5cd68df4115b44f72240eba48ad9b10f3f88077adfe`; verified |
| O3 | [attempt 4 / ci-foundation 103615184353](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250/job/103615184353); [verify 103616203578](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34715044250/job/103616203578) | `2026-09-12T20:18:50Z`–`20:26:33Z` (`7m43s`), about 8 billable minutes | `/private/tmp/g80-w270-o3-job-103615184353.log`; 5 records; maximum line `4747` bytes; reconstruction digest `d2f500d34859ba3c0402e235892174c32e31bc877df3ea33832dc1e099792ca3`; verified |

The common exact target in all logs was
`test/g67-safe-lane.spec.ts` / `AC3: ten paced commits converge through
kicks with cron disabled and record delivery-to-safe intervals`. Healthy and
calibration each had report count `1`, receipt count `1`, receipt state
`passed`, no collection errors, and no unhandled errors. Representatives each
had report count `1`, receipt count `1`, receipt state `failed`, exactly one
failed target, no collection errors, no unhandled errors, and the exact first
line `Test timed out in 10000ms.`. Report, receipt, and installed Vitest were
`4.1.10` in every stage that ran.

#### O1 raw full-precision fields

O1 healthy: process status `0`, elapsed `9064` ms, body `passed/2857` ms;
calibration: process status `0`, elapsed `9949` ms, body `passed/3628` ms;
representative: process status `1`, signal `null`, elapsed `17565` ms, body
`failed/11206` ms, over-budget `1206` ms. The direct signal was:

```text
clock=performance.now; clockValidation={probe:"D1 SELECT 1",samples:3,queriesPerSample:32,minAdvanceMs:26,maxAdvanceMs:27,monotonic:true}; initializationMs=2; initializationSeparated=true; chunks=[{rounds:4,operations:8,deliveryCount:8,durationMs:105,waitersDrained:true},{rounds:8,operations:16,deliveryCount:16,durationMs:151,waitersDrained:true},{rounds:12,operations:24,deliveryCount:24,durationMs:208,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:70,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:72,waitersDrained:true}]; totalRounds=32; operationsPerRound=2; deliveryCount=64; waitersDrained=true; skippedDeliveries=0; omittedWaiterDrain=false; wrongCount=false; timerOnly=false; clockAdvancesDuringRealWork=true; minObservedAdvanceMs=70
```

The raw allowance was `costsPerRoundMs=[26.25,18.875,17.333333333333332,17.5,18]`,
`pairedResidualsMs=[8.75,8.25,0.5]`, residual range `0.5..8.75`, MAD `0.5`,
timer floor `1`, MAD factor `3`, allowance `9.75`, equal-size bound `10`.
Cross-size bounds used reference `18`, ratios `0.5..2`, bounds `9..36`, and
observed range `17.333333333333332..26.25`. The direct lower bound was
`17.333333333333332`, median `18`, predicted added work
`554.6666666666666` ms, and direct signal dominated the allowance. Scaling
ratio was `1.514423076923077`; process overhead was healthy `6207`, calibration
`6321`, representative `6359` ms. Whole-test `signedDifferenceMs=771` and
ratio `1.3900240384615385` are attribution-only. The named representative was
selected at `619` rounds from the conservative direct lower bound, and the
semantic timeout expected and received the same exact message. Stage refs were
`G67-AC3-healthy:healthy:1`,
`G67-AC3-32-round-G69-direct-calibration:calibration:2`,
`g80-estimate:estimate:3`, and
`G67-AC3-619-round-G69-representative:representative-attempt:4`.

#### O2 raw full-precision fields

O2 healthy: process status `0`, elapsed `9480` ms, body `passed/3258` ms;
calibration: process status `0`, elapsed `10417` ms, body `passed/4066` ms;
representative: process status `1`, signal `null`, elapsed `17565` ms, body
`failed/11262` ms, over-budget `1262` ms. The direct signal was:

```text
clock=performance.now; clockValidation={probe:"D1 SELECT 1",samples:3,queriesPerSample:32,minAdvanceMs:31,maxAdvanceMs:33,monotonic:true}; initializationMs=2; initializationSeparated=true; chunks=[{rounds:4,operations:8,deliveryCount:8,durationMs:95,waitersDrained:true},{rounds:8,operations:16,deliveryCount:16,durationMs:175,waitersDrained:true},{rounds:12,operations:24,deliveryCount:24,durationMs:233,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:76,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:79,waitersDrained:true}]; totalRounds=32; operationsPerRound=2; deliveryCount=64; waitersDrained=true; skippedDeliveries=0; omittedWaiterDrain=false; wrongCount=false; timerOnly=false; clockAdvancesDuringRealWork=true; minObservedAdvanceMs=76
```

The raw allowance was `costsPerRoundMs=[23.75,21.875,19.416666666666668,19,19.75]`,
`pairedResidualsMs=[4.75,4,0.75]`, residual range `0.75..4.75`, MAD `0.75`,
timer floor `1`, MAD factor `3`, allowance `6.25`, equal-size bound `10`.
Cross-size bounds used reference `19.75`, ratios `0.5..2`, bounds
`9.875..39.5`, and observed range `19..23.75`. The direct lower bound was
`19`, median `19.75`, predicted added work `608` ms, and direct signal
dominated the allowance. Scaling ratio was `1.25`; process overhead was
healthy `6222`, calibration `6351`, representative `6303` ms. Whole-test
`signedDifferenceMs=808` and ratio `1.3289473684210527` are attribution-only.
The named representative was selected at `533` rounds from the conservative
direct lower bound, and the semantic timeout expected and received the same
exact message. Stage refs were `G67-AC3-healthy:healthy:1`,
`G67-AC3-32-round-G69-direct-calibration:calibration:2`,
`g80-estimate:estimate:3`, and
`G67-AC3-533-round-G69-representative:representative-attempt:4`.

#### O3 raw full-precision fields

O3 healthy: process status `0`, elapsed `9705` ms, body `passed/3451` ms;
calibration: process status `0`, elapsed `10391` ms, body `passed/4052` ms;
representative: process status `1`, signal `null`, elapsed `17363` ms, body
`failed/10960` ms, over-budget `960` ms. The direct signal was:

```text
clock=performance.now; clockValidation={probe:"D1 SELECT 1",samples:3,queriesPerSample:32,minAdvanceMs:31,maxAdvanceMs:34,monotonic:true}; initializationMs=2; initializationSeparated=true; chunks=[{rounds:4,operations:8,deliveryCount:8,durationMs:95,waitersDrained:true},{rounds:8,operations:16,deliveryCount:16,durationMs:187,waitersDrained:true},{rounds:12,operations:24,deliveryCount:24,durationMs:248,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:78,waitersDrained:true},{rounds:4,operations:8,deliveryCount:8,durationMs:91,waitersDrained:true}]; totalRounds=32; operationsPerRound=2; deliveryCount=64; waitersDrained=true; skippedDeliveries=0; omittedWaiterDrain=false; wrongCount=false; timerOnly=false; clockAdvancesDuringRealWork=true; minObservedAdvanceMs=78
```

The raw allowance was `costsPerRoundMs=[23.75,23.375,20.666666666666668,19.5,22.75]`,
`pairedResidualsMs=[4.25,1,3.25]`, residual range `1..4.25`, MAD `1`, timer
floor `1`, MAD factor `3`, allowance `6.25`, equal-size bound `10`.
Cross-size bounds used reference `22.75`, ratios `0.5..2`, bounds
`11.375..45.5`, and observed range `19.5..23.75`. The direct lower bound was
`19.5`, median `22.75`, predicted added work `624` ms, and direct signal
dominated the allowance. Scaling ratio was `1.2179487179487178`; process
overhead was healthy `6254`, calibration `6339`, representative `6403` ms.
Whole-test `signedDifferenceMs=601` and ratio `0.9631410256410257` are
attribution-only. The named representative was selected at `504` rounds from
the conservative direct lower bound, and the semantic timeout expected and
received the same exact message. Stage refs were `G67-AC3-healthy:healthy:1`,
`G67-AC3-32-round-G69-direct-calibration:calibration:2`,
`g80-estimate:estimate:3`, and
`G67-AC3-504-round-G69-representative:representative-attempt:4`.

### AC6 disposition and evidence-only boundary

All three predeclared job-level observations completed and all three archived
logs reconstructed successfully, so this is an AC6-qualifying hosted proof for
the implementation-source head. The three representative timeouts are
semantic proof of the exact named target, not infrastructure or setup
failures. No fourth observation is authorized. W268 attempts and W266
observations remain historical and are not renamed or replaced.

The single evidence-only publication commit contains this W270 section and
the full-precision records above. It does not modify the runner, reporter,
fixture, or lockfile. Its exact evidence head and the ordinary CI result for
that evidence head are recorded in the W270 handoff and PR body after push;
the implementation source head and every measured immutable checkout identity
remain as stated above. No fresh foundation observation is repeated on the
evidence-only head.

## W272 — G79 exclusion and restoration

W272 restores `scripts/g79-vitest-hosted-reporter.mjs` exactly to the base
blob `a4ea6d4e3f13f72e67dd2d79d2591cdce435b225`. That reporter is outside the
G80 source scope and is not claimed as a G80 change. The G80 runner has no
import or reference to it; its command-line JSON/verbose and G80 receipt
reporters replace configured reporters for the measured invocations. The W270
O1–O3 records therefore remain valid without measurement or job reruns.

The measured G80 components remain byte-identical to their W270 values:

| measured G80 path | blob |
| --- | --- |
| `scripts/g73-g67-budget-mutation-runner.mjs` | `ceb91239accd843c9d6a7ba0611020a46c8ee892` |
| `scripts/g80-vitest-receipt-reporter.mjs` | `1cad69dd34de905f8135f49fb81bcebc0f2be17d` |
| `scripts/fixtures/g80-w226-stack-trace-error.json` | `afa4dc4667b61963deaea621c44616e46808e4bd` |
| `package-lock.json` | `e611de40b6c7423faebd8325e8ba45f870681d5f` |

The restored G79 blob and the four measured G80 blobs were checked directly
against their required base/measurement identities. This is a source/doc
correction only; no workflow, product code, test, budget, measurement or
rerun was changed or initiated.

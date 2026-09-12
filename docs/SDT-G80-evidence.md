# SDT-G80 — deterministic G67 budget calibration

Task: `SDT-G80-IMPLEMENTATION-W264`

Issue: [#162](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/162)

Product-gap context: [intent-system#1784](https://github.com/J-Tech-Japan/intent-system/issues/1784)

This implementation starts from `origin/main` at
`e0988822b91ad664cfddfdb9125d0251faa5fb37` on the dedicated branch
`claude/sdt-g80-implementation-w264`. The closed historical PR #163 and its
branch were not reused, reopened, rebased, or pushed. The change is limited to
the G80 runner, its structured Vitest receipt reporter, and this evidence
document. It does not change production code, the checked-in G67 AC3 body or
budget, the G73 driver-timing guard, G71, G74, G77, G78, any workflow, or any
unrelated lane.

## AC1 — observation-only baseline

The pre-G80 runner source hash recorded by the runner is
`74e024444725c5aa01f01b8e1346b5329099e9c60135babd66186a11e1c3d7ee`. Its
legacy whole-test subtraction and one-millisecond clamp remain available only
under `--observation-only`; normal calibration does not use that estimator.
Observation-only mode retains each subprocess JSON report and structured
receipt under `.artifacts/sdt-g80-observation/` and emits each healthy and
calibration input before any estimator branch. A local invocation records
process/report provenance but cannot establish separate hosted job instances.

The historical receipts remain distinct:

| source | observed result | disposition |
| --- | --- | --- |
| main `809d535ee93e2318b46234db47ffb2d94b1949a1`, workflow `34418417311`, job `102688333944` | healthy 3,230 ms; 32-round calibration 4,681 ms; difference 1,451 ms; 224 rounds passed at 8,163 ms and 336 rounds timed out at 10,006 ms | historical legacy receipt |
| main `193cfa44563d08ffadef146c4eca769098044be1`, workflow `34465922635`, job `102834361879` | legacy runner reported representative estimate 4,742 and stopped before emitting a raw pair | historical failure; no causal claim |
| G71 PR #161, head `565625c0a48bf64d24dd0db6d1be25af6ef8819f`, workflow `34473938826`, job `102878368630` | healthy 2,860 ms; calibration 3,460 ms; difference 600 ms; 572 rounds timed out at 10,145 ms | historical cross-branch receipt |

The issue's five fresh legacy pairs are not relabelled as collected by this
branch. They remain `0/5`, superseded by the design ruling, and unavailable
as fresh hosted evidence. The observations above do not establish that noise
caused the 4,742 result.

## AC2 — direct real-work timing

The normal G80 mutation measures the real injected G69 path in the G67 test
body. It keeps the existing single-first-commit boundary, creates two complete
unique `g32Message` deliveries per round, calls the real `D1EventStore`, and
awaits every diagnostic waiter after each `recordDelivery`. One-time store
initialization is measured separately and is not charged to every round. No
timer, `Date.now()`, `process.hrtime`, enqueue-only shortcut, or synthetic
delay is used.

The predeclared direct plan is:

```text
chunks:              [4, 8, 12, 4, 4] rounds
total calibration:   32 rounds
operations/round:    2 complete deliveries
direct work:         64 deliveries, 64 drained waiter sets
elapsed ceiling:     5,000 ms
clock:               performance.now() inside the Vitest body
clock validation:    3 samples, 32 real D1 SELECT 1 queries per sample
```

The clock probe is real D1 I/O and is required to advance positively for every
sample. The first local attempt used four queries per sample and correctly
failed closed when one Workerd/Miniflare interval was quantized to zero. The
bounded probe was then calibrated to 32 queries per sample; no sleep or timer
was introduced. The successful run recorded three positive samples of 5–6 ms,
`monotonic: true`, and a separately measured initialization cost of 1 ms.

The direct calibration output from the successful local proof was:

| field | value |
| --- | ---: |
| healthy G67 body | 776 ms |
| healthy budget margin | 9224 ms |
| 32-round body | 1075 ms |
| signed whole-test difference | 299 ms (cross-check only) |
| direct median cost | 6.25 ms/round |
| direct conservative lower-bound cost | 5.25 ms/round |
| predicted 32-round added cost from lower bound | 168 ms |
| whole-test attribution ratio | 1.7797619047619047 (diagnostic only) |
| chunk durations | 27, 54, 67, 21, 25 ms for 4, 8, 12, 4, 4 rounds |
| direct rate range | 5.25 to 6.75 ms/round |
| matched-residual allowance | 2.5 ms/round |

The three 4-round chunks are the matched repeated controls. The allowance is
declared from their per-round residuals (`1.5`, `0.5`, `1` ms), the median
absolute deviation (`0.5` ms), the three-MAD factor, and a one-millisecond
clock-resolution floor. The scaling and residual checks are two-sided and
predeclared; a ratio that merely accepts all positive inputs is not used.
Whole-test duration differences are retained as attribution data and are not
compared with the per-round allowance.

## AC3 — fail-closed outcomes

The normal estimator no longer clips a raw signal with `Math.max(1, ...)`.
Each outcome is emitted with raw measurements before its branch and on failure:

| outcome | condition |
| --- | --- |
| `HEALTHY_OR_ORACLE_FAILURE` | missing/malformed process report, receipt, marker, target, setup, signal, or process state |
| `CALIBRATION_INCONCLUSIVE` | malformed direct signal, no valid matched residual allowance, a direct rate outside either predeclared cross-size bound, an equal-size residual above its predeclared bound, or a direct lower bound that does not dominate the same-unit allowance |
| `REPRESENTATIVE_RANGE_EXCEEDED` | a valid conservative estimate requires more than the unchanged 4,096 representative rounds |

Representative escalation occurs only after the named healthy target passes.
The representative is chosen from the conservative direct lower-bound rate and
the existing 1.5 safety factor, with no retry-until-green behavior. Timeout
overshoot is retained as a censored observation rather than used as a workload
margin.

## W266 — accepted bounded-calibration decision

The W266 repair applies the accepted W265 ruling to the runner beginning at
source head `f8d5c34c6c4ffb4e7eef4de37cc5125e39002aee`. The measurement contract
is predeclared before the direct observation: every chunk rate must be within
`[0.5 × median, 2 × median]`, every same-size residual must be at most `10`
ms/round, and the direct lower-bound rate must be strictly greater than the
MAD-derived allowance. These are rates and allowances in the same ms/round
unit. The unchanged `safetyFactor: 1.5` and `maxRepresentativeRounds: 4096`
remain in force.

The retained W264 hosted receipt can be evaluated against the repaired rule
without rerunning it. Its raw direct timing values were:

| value | raw full-precision receipt value |
| --- | ---: |
| chunk rounds | `[4, 8, 12, 4, 4]` |
| chunk durations (ms) | `[104, 148, 338, 68, 81]` |
| direct costs (ms/round) | `[26, 18.5, 28.166666666666668, 17, 20.25]` |
| direct-rate median | `20.25` |
| cross-size lower/upper bounds | `10.125` / `40.5` |
| observed direct-rate minimum/maximum | `17` / `28.166666666666668` |
| same-size residuals (ms/round) | `[9, 5.75, 3.25]` |
| same-size residual maximum / bound | `9` / `10` |
| MAD-derived allowance (ms/round) | `13.25` |
| conservative direct lower-bound rate | `17` |
| healthy body / calibration body (ms) | `631` / `583` |
| signed whole-test difference (ms) | `-48` |
| lower-bound 32-round predicted work (ms) | `544` |
| whole-test attribution ratio | `-0.08823529411764706` |

The historical hosted pair's healthy and calibration body values are retained
as attribution diagnostics only; the negative whole-test difference is not a
failure condition. The exact repaired decision path is: (1) parse one
structured direct marker; (2) validate real `performance.now` D1 probes,
complete deliveries, exact operations and waiter drains; (3) pass all five
chunk rates through the predeclared two-sided bounds; (4) pass the three
same-size residuals through the `10` ms/round bound; (5) accept because
`17 > 13.25` in ms/round; and (6) size representative rounds from the
conservative `17` ms/round lower bound. The whole-test `-48` ms value is
reported for attribution and is deliberately not compared with `13.25`.

The retained W264 local proof has the following exact arithmetic, also kept
without rounding in the repaired evidence: chunk durations
`[27, 54, 67, 21, 25]` ms produce direct rates
`[6.75, 6.75, 5.583333333333333, 5.25, 6.25]` ms/round; median `6.25`,
cross-size bounds `[3.125, 12.5]`, direct lower bound `5.25`, same-size
residuals `[1.5, 0.5, 1]`, residual maximum `1.5`, allowance `2.5`, healthy
body `776`, calibration body `1075`, signed whole-test difference `299`,
lower-bound predicted work `168`, and whole-test attribution ratio
`1.7797619047619047`. It passes the same path because `5.25 > 2.5`.

The post-repair focused local proof (not a hosted AC6 instance) emitted these
raw values at the W266 working tree: healthy body `1648` ms, healthy margin
`8352` ms, calibration body `2783` ms, signed whole-test difference `1135` ms,
direct rates `[14.5, 15.125, 16.166666666666668, 12, 13.5]` ms/round, direct
median `14.5`, conservative lower bound `12`, cross-size bounds `[7.25, 29]`,
same-size residuals `[2.5, 1, 1.5]`, residual maximum `2.5`, allowance `3`,
lower-bound predicted work `384`, and whole-test attribution ratio
`2.9557291666666665`. The decision accepted only because `12 > 3`; it then
selected `1044` representative rounds from the lower bound and observed a
`15179` ms target body, `5179` ms over the 10000 ms budget, with one exact
structured timeout, process status `1`, and `signal: null`. This is a
mechanism proof; it does not substitute for the later hosted receipts.

The runner self-test now retains named structured mutant results:

| mutant | exact fixture and expected red reason |
| --- | --- |
| whole-test/per-round unit mismatch | rates `[10, 10, 11]`, allowance `1`, signed difference `0.5`; accepted by the direct gate and marked attribution-only, so the old whole-test-ms-versus-per-round-ms gate is killed |
| inconclusive direct signal | rates `[0.25, 0.25, 0.2625]`, allowance `1`, lower bound `0.25`; rejected because the direct lower bound does not dominate the same-unit allowance |
| low cross-size bound | rates `[4, 10, 11]`, median `10`, lower bound `5`; rejected because `4 < 5` |
| high cross-size bound | rates `[10, 25, 11]`, median `11`, upper bound `22`; rejected because `25 > 22` |
| equal-size residual | rates `[8, 10, 19]`, median `10`, cross-size bounds `[5, 20]`; rejected because the repeated-size residual `11 > 10` |

The self-test also retains the ANSI/truncated/missing direct-marker checks,
the healthy and named-timeout controls, and the existing G67 source-shape
proof. No G67 fixture, product behavior, workflow, timeout, retry, skip or
unrelated lane was changed.

## W266 — accepted bounded-calibration decision

The W266 repair applies the accepted W265 ruling to the runner beginning at
source head `f8d5c34c6c4ffb4e7eef4de37cc5125e39002aee`. The measurement contract
is predeclared before the direct observation: every chunk rate must be within
`[0.5 × median, 2 × median]`, every same-size residual must be at most `10`
ms/round, and the direct lower-bound rate must be strictly greater than the
MAD-derived allowance. These are rates and allowances in the same ms/round
unit. The unchanged `safetyFactor: 1.5` and `maxRepresentativeRounds: 4096`
remain in force.

The retained W264 hosted receipt can be evaluated against the repaired rule
without rerunning it. Its raw direct timing values were:

| value | raw full-precision receipt value |
| --- | ---: |
| chunk rounds | `[4, 8, 12, 4, 4]` |
| chunk durations (ms) | `[104, 148, 338, 68, 81]` |
| direct costs (ms/round) | `[26, 18.5, 28.166666666666668, 17, 20.25]` |
| direct-rate median | `20.25` |
| cross-size lower/upper bounds | `10.125` / `40.5` |
| observed direct-rate minimum/maximum | `17` / `28.166666666666668` |
| same-size residuals (ms/round) | `[9, 5.75, 3.25]` |
| same-size residual maximum / bound | `9` / `10` |
| MAD-derived allowance (ms/round) | `13.25` |
| conservative direct lower-bound rate | `17` |
| healthy body / calibration body (ms) | `631` / `583` |
| signed whole-test difference (ms) | `-48` |
| lower-bound 32-round predicted work (ms) | `544` |
| whole-test attribution ratio | `-0.08823529411764706` |

The historical hosted pair's healthy and calibration body values are retained
as attribution diagnostics only; the negative whole-test difference is not a
failure condition. The exact repaired decision path is: (1) parse one
structured direct marker; (2) validate real `performance.now` D1 probes,
complete deliveries, exact operations and waiter drains; (3) pass all five
chunk rates through the predeclared two-sided bounds; (4) pass the three
same-size residuals through the `10` ms/round bound; (5) accept because
`17 > 13.25` in ms/round; and (6) size representative rounds from the
conservative `17` ms/round lower bound. The whole-test `-48` ms value is
reported for attribution and is deliberately not compared with `13.25`.

The retained W264 local proof has the following exact arithmetic, also kept
without rounding in the repaired evidence: chunk durations
`[27, 54, 67, 21, 25]` ms produce direct rates
`[6.75, 6.75, 5.583333333333333, 5.25, 6.25]` ms/round; median `6.25`,
cross-size bounds `[3.125, 12.5]`, direct lower bound `5.25`, same-size
residuals `[1.5, 0.5, 1]`, residual maximum `1.5`, allowance `2.5`, healthy
body `776`, calibration body `1075`, signed whole-test difference `299`,
lower-bound predicted work `168`, and whole-test attribution ratio
`1.7797619047619047`. It passes the same path because `5.25 > 2.5`.

The runner self-test now retains named structured mutant results:

| mutant | exact fixture and expected red reason |
| --- | --- |
| whole-test/per-round unit mismatch | rates `[10, 10, 11]`, allowance `1`, signed difference `-50`; accepted by the direct gate and marked attribution-only, so the old whole-test gate is killed |
| inconclusive direct signal | rates `[0.25, 0.25, 0.2625]`, allowance `1`, lower bound `0.25`; rejected because the direct lower bound does not dominate the same-unit allowance |
| low cross-size bound | rates `[4, 10, 11]`, median `10`, lower bound `5`; rejected because `4 < 5` |
| high cross-size bound | rates `[10, 25, 11]`, median `11`, upper bound `22`; rejected because `25 > 22` |
| equal-size residual | rates `[8, 10, 19]`, median `10`, cross-size bounds `[5, 20]`; rejected because the repeated-size residual `11 > 10` |

The self-test also retains the ANSI/truncated/missing direct-marker checks,
the healthy and named-timeout controls, and the existing G67 source-shape
proof. No G67 fixture, product behavior, workflow, timeout, retry, skip or
unrelated lane was changed.

## AC4 — structured named timeout oracle

`scripts/g80-vitest-receipt-reporter.mjs` is passed only to the runner's own
Vitest subprocess alongside the existing JSON and verbose reporters. It writes
one unique receipt per invocation containing Vitest version, process/runtime
metadata, module/full name/test id, state, duration, configured timeout,
retry/repeat data, and each error's `name`, `message`, `stack`, and `code`
separately. Collection errors, unhandled errors, final status, process status,
signal, and spawn error are retained.

The final red validator accepts only one failed instance of the exact G67 AC3
test, with a normal nonzero process exit and no signal/spawn error, no other
failed target, no collection/unhandled error, duration at least 10,000 ms, and
one structured error whose first message line is exactly
`Test timed out in 10000ms.`. It rejects setup/import failures, unrelated or
duplicate targets, missing/green targets, signals, malformed receipts, and
timeout text borrowed from combined output. The actual Vitest conformance
self-test uses a real 10 ms timeout and validates the structured message
`Test timed out in 10ms.`; negative process/report/receipt cases are also
self-tested.

The successful local representative proof selected 2,214 rounds. It measured a
16,986 ms target body and produced exactly one structured timeout failure with
normal process status `1`, `signal: null`, no collection errors, and no
unhandled errors. This is a local mechanism proof, not a hosted receipt.

## AC5 — preserved boundary

The checked-in `test/g67-safe-lane.spec.ts` remains byte-for-byte identical to
the base. Its 33-obligation fixture, SQL pending selection of 32, first-send
cardinality 32, non-null re-arm, acknowledgement of 32, second-send
cardinality 33, zero pending findings, final null alarm, and 10,000 ms budget
remain unchanged. `maxRepresentativeRounds` remains 4,096 and
`safetyFactor` remains 1.5. The G73 driver-timing guard remains the first
command in `test:g73:guard` and is unchanged.

## AC6 — process and hosted-evidence boundary

The required final hosted evidence is three fresh job instances on one final
source/lockfile, each retaining healthy, direct-calibration, estimate,
representative, and terminal receipt data. This implementation task permits
only the ordinary exact-head pull-request workflow; it does not dispatch a
workflow or rerun unrelated jobs. Therefore those three fresh hosted job
instances are not claimed here until the normal hosted receipts are available.
The historical receipts above remain historical and are not silently promoted.

Local checks completed on the fresh branch:

| check | result |
| --- | --- |
| `npm ci` with isolated `/private/tmp/sdt-g80-npm-cache` | passed |
| `npm run build:packages` | passed |
| `node --check scripts/g73-g67-budget-mutation-runner.mjs` | passed |
| `node --check scripts/g80-vitest-receipt-reporter.mjs` | passed |
| `npx eslint . --max-warnings=0` | passed |
| `node scripts/g73-g67-budget-mutation-runner.mjs --self-test` | passed |
| `npm run test:g73:guard` | passed: healthy control, direct calibration, and named timeout representative |
| G67 source identity | `cmp` against base is required before commit; no G67 file is in the diff |

No CI, release-preflight, workflow dispatch, unrelated rerun, product change,
G67 body change, timeout inflation, skip, retry, or flaky annotation was made
by this branch. The next step is review of the fresh PR and, subject to the
normal exact-head workflow, attachment of the required hosted receipts.

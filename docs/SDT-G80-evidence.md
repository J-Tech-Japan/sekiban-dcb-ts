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
| healthy budget margin | 9,224 ms |
| 32-round body | 1,075 ms |
| signed whole-test difference | 299 ms (cross-check only) |
| direct median cost | 6.25 ms/round |
| predicted 32-round added cost | 200 ms |
| observed/predicted ratio | 1.495 |
| chunk durations | 27, 54, 67, 21, 25 ms for 4, 8, 12, 4, 4 rounds |
| per-round scaling ratio | 1.2857 |
| matched-residual allowance | 2.5 ms/round |

The two 4-round chunks are the matched repeated controls. The allowance is
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
| `CALIBRATION_INCONCLUSIVE` | negative/small signal, no valid matched residual allowance, missing two-sided scaling, or inconsistent whole-test cross-check |
| `REPRESENTATIVE_RANGE_EXCEEDED` | a valid conservative estimate requires more than the unchanged 4,096 representative rounds |

Representative escalation occurs only after the named healthy target passes.
The representative is chosen from the measured direct rate and existing 1.5
safety factor, with no retry-until-green behavior. Timeout overshoot is retained
as a censored observation rather than used as a workload margin.

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

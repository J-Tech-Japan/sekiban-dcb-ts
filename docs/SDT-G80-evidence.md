# SDT-G80 — deterministic G67 budget calibration

Task: SDT-G80-IMPLEMENTATION-W217.

Implementation PR: https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/163
Repair source head: 4cefc3f54294de6be5867ac5925d0f1f8287fe3b

This change is limited to the G73 G67 budget mutation runner and its proof
evidence. It does not change the G67 AC3 test body or budget, production code,
the G73 driver-timing guard, G71, G74, G77, G78, or any CI lane. The existing
G73 guard remains the first command in test:g73:guard; no timeout, skip, retry,
or flaky annotation was added.

## W226 ANSI-marker repair and hosted receipt

W226 resumed the existing PR after the canonical `intent-pr-request-update`
lifecycle was restored. The PR was claimed with the GitHub-only worker
protocol, and the repair was made on the existing branch from the reviewed
head `4a225ef157226af279c8e8d702ef72bd7a026e51` (main base
`193cfa44563d08ffadef146c4eca769098044be1`). The source repair commit is
`4cefc3f54294de6be5867ac5925d0f1f8287fe3b`.

The failed source receipt is workflow
[34486440265](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34486440265),
head `4a225ef157226af279c8e8d702ef72bd7a026e51`, ci-foundation job
[102901815567](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34486440265/job/102901815567).
Its diagnosed failure was that the complete
`G80_G73_DIRECT_TIMING` line began with the SGR prefix
`ESC[22mESC[39m`; the old raw `startsWith(marker + " ")` check therefore
classified the valid receipt as `HEALTHY_OR_ORACLE_FAILURE`. The retrievable
job log ends after the runner self-test and does not retain the final error
line; that missing log detail is not reconstructed here.

The repair strips SGR `ESC[...m` sequences before line matching and requires
exactly one normalized marker. Missing, truncated, malformed, and duplicate
markers fail closed. The executable self-test covers the actual colour prefix
`ESC[22mESC[39m`, a truncated marker, a missing marker, a truncated JSON
payload, and duplicate markers. No estimator, clock, product code, G67
fixture, budget, G73 guard, workflow, or unrelated lane changed.

The first exact-head repair workflow was
[34509483454](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454),
head `4cefc3f54294de6be5867ac5925d0f1f8287fe3b`. It reached terminal
`failure` with these relevant receipts:

| job | terminal result | evidence |
| --- | --- | --- |
| [ci-foundation](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454/job/102979771152) | failure | `npm test` passed: 95 files, 806 tests, 1 skipped; G73 equality self-test passed; the ANSI parser self-test passed; the subsequent unchanged G67/G73 runner step failed before a durable G80 result or marker was emitted |
| [ci-g46](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454/job/102979771313) | failure | unrelated existing `test/read.spec.ts:338` assertion expected HTTP 500 but observed 200; no G46/G80 file was changed |
| [verify](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454/job/102994280734) | failure | aggregate required-check failure from the two failed jobs above |

The exact-head hosted log contains neither `G80_AC1_OBSERVATION_INPUT` nor
`G80_AC1_OBSERVATION_SUMMARY`, and no `G80_G73_DIRECT_TIMING` marker. The
workflow invokes the normal `test:g73:guard` command, not
`--observation-only --pairs=5`; consequently zero of the five predeclared
AC1 observation pairs ran as fresh hosted observations. The hosted run is a
terminal repair receipt, not evidence of a green calibration or timeout
proof. The existing local pair remains censored by the unchanged
`invalid_sortable_unique_id` fixture failure and is not promoted to hosted
evidence.

## Baseline and observation capture

The branch starts from origin/main at
193cfa44563d08ffadef146c4eca769098044be1. The pre-G80 runner source hash is
74e024444725c5aa01f01b8e1346b5329099e9c60135babd66186a11e1c3d7ee.
The old runner inferred the cost of 32 rounds from the difference between two
whole-test Vitest durations and clipped that value to at least one
millisecond. That inference is retained only as an observation-only
compatibility capture; the normal proof no longer uses the clipped estimate.

The issue's historical main receipts are:

| source / receipt | result relevant to G80 |
| --- | --- |
| main 193cfa44, workflow 34465922635 | G73 runner failed G67 representative exceeds bounded calibration range: 4742 rounds; no healthy/direct calibration was emitted |
| main 809d535e, workflow 34418417311 | healthy body 3,230 ms; 32-round calibration body 4,681 ms; signed whole-test difference 1,451 ms; representative 224 passed at 8,163 ms and 336 timed out at 10,006 ms |
| G71 PR 565625c0, workflow 34473938826 | the old runner's guard step passed; this is a historical cross-branch receipt, not a G80 result |

The old runner's observation command is now available as:

    node scripts/g73-g67-budget-mutation-runner.mjs --observation-only --pairs=5

It preserves every temporary Vitest JSON report below
.artifacts/sdt-g80-observation/, emits each healthy/calibration input before
any estimator branch, and records source SHA, checkout, workflow, job, run,
attempt, process status, body status, body duration, signal, and end-to-end
process cost. A local invocation cannot establish the required five fresh
hosted job instances. The required hosted collection is therefore still
explicitly missing until five separate hosted job receipts are attached:

| predeclared pair | fresh hosted job receipt | healthy input | 32-round calibration input | status |
| ---: | --- | --- | --- | --- |
| 1 | missing | missing | missing | not collected |
| 2 | missing | missing | missing | not collected |
| 3 | missing | missing | missing | not collected |
| 4 | missing | missing | missing | not collected |
| 5 | missing | missing | missing | not collected |

The one local capture made while validating the runner is not promoted to
hosted evidence. Both inputs failed before G80 injection with the same
pre-existing error at test/g67-safe-lane.spec.ts:782:
invalid_sortable_unique_id / lastSortableUniqueId must be a 30-digit
SortableUniqueId. The retained receipts are:

    .artifacts/sdt-g80-observation/g80-observation-pair-1-healthy-20948-1.json
    .artifacts/sdt-g80-observation/g80-observation-pair-1-calibration-20948-2.json

The observation output reported body durations of 14 ms and 15 ms only because
the fixture failed early; they are censored failure observations, not cost
measurements. No G80 result is inferred from them.

## Direct injected-work measurement

The normal runner keeps the existing one-commit boundary (index === 1),
32 calibration rounds, two complete unique recordDelivery operations per
round, and await Promise.all(extraWaiters) after every operation. The
temporary block uses the real D1EventStore and g32Message/g32SuidAt
envelopes. It does not enqueue-only, use a timer, or use synthetic delay.

The direct calibration plan is predeclared before execution:

    chunks: [4, 8, 12, 4, 4]
    total rounds: 32
    operations per round: 2
    elapsed ceiling: 5,000 ms
    clock: performance.now()

The first store initialization is measured separately. Each chunk records
positive finite elapsed time, exact operation and delivery count, and waiter
drain. The runner emits a G80_G73_DIRECT_TIMING JSON marker only after all
chunks complete. The marker records the clock, initialization cost, chunk
durations, total rounds, delivery count, and proof flags. A malformed marker,
missing chunk, non-positive/non-finite duration, wrong count, skipped delivery,
omitted waiter drain, timer-only workload, frozen/mock clock, or elapsed-ceiling
failure is rejected.

The two 4-round chunks are the matched repeated direct controls. The allowance
is derived before the representative branch from their per-round residual
range and median absolute deviation, with a declared one-millisecond clock
resolution floor and a declared three-MAD factor. There is no
Math.max(1, rawDifference) clamp in the normal estimator. The whole-test
duration difference is retained only as a cross-check against the direct
predicted cost; it cannot substitute for direct timing.

Calibration outcomes are separate and fail closed:

| outcome | trigger | proof behavior |
| --- | --- | --- |
| HEALTHY_OR_ORACLE_FAILURE | healthy/calibration report, target, process, signal, marker, or setup is invalid | fails with the exact receipt details |
| CALIBRATION_INCONCLUSIVE | signed whole-test signal is not above the predeclared allowance, scaling is absent, or predicted and observed added cost do not agree | fails without clipping or inventing a cost |
| REPRESENTATIVE_RANGE_EXCEEDED | the direct estimate requires more than 4,096 representative rounds | fails without raising the cap or changing the operation boundary |

The healthy body and the existing 10,000 ms budget remain the authority for
the final red. The representative branch does not retry calibration until it
gets a favorable result; it geometrically searches only for the prescribed
timeout representative after a valid calibration.

## Final red oracle and executable self-test

The timeout oracle now consumes the structured Vitest JSON result for the
named G67 AC3 test. It requires all of the following:

- exactly one matching target assertion;
- a readable report and a numeric nonzero process status;
- no terminating signal;
- target status failed;
- target body duration at least 10,000 ms;
- exactly one target failure message containing the 10,000 ms timeout.

An unrelated timeout, missing test, setup failure, signal, swallowed work
failure, malformed report, or missing target therefore cannot certify the
red mutant. The self-test exercises the healthy control, all three explicit
outcomes, the valid timeout receipt, and rejection cases for signal, missing
target, and setup/module failure. It also rejects mocked/frozen clocks, zero
and non-finite durations, skipped deliveries, omitted waiter drains, wrong
counts, and timer-only work. The mutated G67 source is required to contain
the real D1 delivery path and performance.now, and the inserted timing seam
is required to contain neither Date.now() nor process.hrtime.

The G67 AC3 source remains byte-for-byte unchanged by this branch. Its
33-obligation fixture, SQL pending selection of 32, first-send cardinality 32,
non-null re-arm, acknowledgement of 32, second-send cardinality 33, zero
pending findings, and final null alarm remain outside the mutation.

## Verification receipts

| command | result |
| --- | --- |
| node --check scripts/g73-g67-budget-mutation-runner.mjs | passed |
| node scripts/g73-g67-budget-mutation-runner.mjs --self-test | passed; direct timing seam, three outcomes, strict timeout oracle, and negative cases exercised |
| npx eslint scripts/g73-g67-budget-mutation-runner.mjs | passed |
| npm run test:g73:guard | blocked locally before injected work by the unchanged G67 fixture/runtime error at test/g67-safe-lane.spec.ts:782; exact error and retained observation receipts are recorded above |
| npm run build:packages | baseline repository failure outside G80: dcb-client SnapshotReader.head type errors and existing meeting-room/runtime package surface mismatches; no source change was made to address them |
| hosted workflow 34509483454 at 4cefc3f | terminal failure; ci-foundation passed the 807-test npm phase and both guard self-tests, then failed in the unchanged G67/G73 runner step; ci-g46 independently retained its existing read-contract assertion failure; no hosted AC1 observation pair ran |

No product behavior was changed, and no hosted green result or hosted AC1
pair is claimed. The five-pair observation receipts and final
healthy/calibration/timeout terminal proof remain missing after this bounded
parser repair; the exact missing hosted result is reported for follow-up
disposition rather than inferred from the self-test.

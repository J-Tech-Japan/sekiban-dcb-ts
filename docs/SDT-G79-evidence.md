# SDT-G79 hosted budget evidence

Task: `SDT-G79-HOSTED-BUDGET-CALIBRATION-W204`

This document records the measurement and proof for the G43 hosted test lane.
It does not change product behavior or the G43 proof boundary. The held PR
#158 and `test/g43-tag-sql.spec.ts` on that PR were not modified or rerun for
this unit.

## Measure-first baseline

The branch was based on `origin/main` at
`809d535ee93e2318b46234db47ffb2d94b1949a1`. Before the G79 source change, the
available main receipts showed the G43 lane's file and suite cost below. The
existing hosted reporter did not emit assertion-level durations, so those
receipts cannot honestly be used as per-test measurements; the G79 lane now
emits the supported Vitest JSON assertion durations for every one of its 20
tests.

| main workflow | `ci-g43` job | G43 file | G43 suite | workflow wall-clock | result |
| --- | --- | ---: | ---: | ---: | --- |
| [34418417311](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34418417311) | [102688334001](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34418417311/job/102688334001) | 1,154 ms | 10.49 s | 35 m 44 s | green |
| [34355159919](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34355159919) | [102477845973](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34355159919/job/102477845973) | 1,312 ms | 11.03 s | 43 m 32 s | G43 green; another lane failed |
| [34328164091](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34328164091) | [102390191887](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34328164091/job/102390191887) | 1,457 ms | 11.56 s | 44 m 53 s | G43 green; another lane failed |
| [34302437259](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259) | [102312021240](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259/job/102312021240) | 2,464 ms | 14.62 s | 43 m 34 s | G43 green; another lane failed |
| [34287701420](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287701420) | [102266997180](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287701420/job/102266997180) | 1,199 ms | 10.17 s | 42 m 16 s | G43 had a separate G43 AC6 in-flight failure |
| [34250139096](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34250139096) | [102142154788](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34250139096/job/102142154788) | 1,246 ms | 10.81 s | 42 m 17 s | green |

The triggering regression receipt is [PR #158 run
34423535120](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34423535120/job/102703848479): the backlog test inherited Vitest's 5,000 ms budget, consumed
5,121 ms, timed out without an assertion failure, and the whole file was
reported as 9,106 ms. That is measured expensive fixture work, not evidence of
a G43 semantic defect; the main receipts above show the file itself stays
green and the G79 mutant oracle preserves the semantic checks.

## Governing budgets and checkable basis

The measurable near-budget boundary is `duration >= 50%` of the governing
budget. The timing reporter prints every assertion, its duration, budget,
remaining margin, source of the budget, and this classification. A test below
that threshold is listed as comfortable; a test at or above it is listed as
near-budget. The hosted tables below are intentionally left as a receipt, not
inferred from local timing.

| test / budget source | budget | basis and margin |
| --- | ---: | --- |
| G43 AC6 33-obligation backlog | 10,000 ms, written per-test in `test/g43-tag-sql.spec.ts` | 33 sequential durable appends plus the real SQL `LIMIT 32`, two production alarm-body passes, receipt acknowledgements, and final re-arm scan are the measured work. The margin is the hosted `10,000 - observed` value in each receipt; this budget is raised because the failure consumed 5,121 ms with no assertion failure, not to hide a defect. |
| G43 structural measurement | 60,000 ms, explicitly retained in `test/g43-measurement.spec.ts` | Five history sizes × three repetitions exercise real Tag-DO SQL transitions and the range-plan proof. The margin is the hosted `60,000 - observed` value; the test's decision remains structural row/byte/index evidence, not elapsed time. |
| Other 18 tests in the G43 lane | 5,000 ms, Vitest inherited default | No budget is changed. Each test is emitted by the hosted timing report; every near-budget result is named there, while comfortable results remain on the inherited default. A green anecdote is not used as the basis for the selected 10,000 ms budget. |

## AC1 per-test hosted receipts

The G79 timing reporter is wired into `npm run test:g43` and prints one
`SDT-G79_HOSTED_TEST_TIMING` JSON line for each of the 20 assertions. Direct
per-test hosted receipts and repeated-run values will be appended here after
the dedicated PR's terminal CI runs. Until those runs exist, this section does
not claim that local durations are hosted evidence.

| exact-head hosted run | `ci-g43` job | 20 assertion timing rows | terminal result |
| --- | --- | --- | --- |
| pending at initial implementation handoff | pending | pending | not yet collected |

## AC3 unchanged proof and red mutants

The final test still enqueues exactly 33 obligations, proves the source query
returns exactly 32 rows, sends 32 in the first bounded alarm pass, observes a
non-null alarm re-arm, acknowledges those 32, sends the 33rd on the next pass,
and ends with zero pending findings and a null alarm. No assertion, SQL limit,
or re-arm behavior was removed.

`scripts/g79-budget-mutation-runner.mjs` restores the source after each case
and proves both required red mutations:

1. `shrink-backlog-below-alarm-budget` changes the enqueue loop from 33 to 32
   and runs the focused real Vitest AC6 oracle; the expected tail-count
   assertion fails.
2. `remove-rearm-assertion` removes the non-null re-arm assertion from a
   temporary test copy and runs the AC6 proof-shape contract; the contract
   fails because the proof boundary was weakened.

The hosted terminal receipts for the two red results will be appended with the
exact run/job identity. Local execution already returned `both-red`; it is not
substituted for the required hosted evidence.

## Before/after wall-clock cost

The baseline workflow and `ci-g43` durations above are the before receipts.
After-calibration workflow and `ci-g43` durations, plus the repeated exact-head
G43 observations, will be recorded from the dedicated PR's terminal hosted
runs. No claim about an after cost is made before those receipts are available.

## Scope and missing evidence

Only the G43 test budget, G43-lane timing reporter, G79 mutation runner, and
this evidence are in scope. There is no product-code change, no G43 repair,
no assertion removal, no skip/flaky annotation, no CI timeout inflation, and
no change to PR #158. The explicit missing items above are the hosted
assertion-level and after-calibration receipts; they must be filled from
openable exact-head CI logs rather than inferred from local runs.

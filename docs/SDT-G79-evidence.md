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
per-test hosted receipts were collected on two terminal attempts at the same
exact head. Each `ci-g43` job runs the normal lane and the forced-red lane, so
the four values below are `attempt 1 normal / forced-red` and
`attempt 2 normal / forced-red`, in milliseconds. The minimum margin is the
smallest margin across those four hosted observations.

| exact-head hosted run | `ci-g43` job | terminal result |
| --- | --- | --- |
| [34427912295 attempt 1](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295) | [102716974790](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/job/102716974790) | green |
| [34427912295 attempt 2](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/attempts/2) | [102725811608](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/job/102725811608) | green |

All 20 assertions were comfortable (`nearBudget: []`) in both attempts. The
complete rows are:

| assertion | attempt 1 ms | attempt 2 ms | budget / source | minimum margin | classification |
| --- | ---: | ---: | --- | ---: | --- |
| golden digest | 6 / 7 | 5 / 7 | 5,000 / inherited | 4,993 ms | comfortable |
| duplicate/reordered tags | 2 / 1 | 2 / 2 | 5,000 / inherited | 4,998 ms | comfortable |
| non-projected field fails closed | 0 / 1 | 1 / 1 | 5,000 / inherited | 4,999 ms | comfortable |
| distinct event identities | 1 / 1 | 1 / 1 | 5,000 / inherited | 4,999 ms | comfortable |
| real Tag-DO SQL measurement | 6,619 / 7,458 | 7,102 / 7,703 | 60,000 / retained explicit | 52,297 ms | comfortable |
| invalid measurement shapes | 8 / 12 | 7 / 12 | 5,000 / inherited | 4,988 ms | comfortable |
| commit five normalized facts | 63 / 57 | 75 / 61 | 5,000 / inherited | 4,925 ms | comfortable |
| rollback five facts | 27 / 27 | 40 / 29 | 5,000 / inherited | 4,960 ms | comfortable |
| first-write identity/rejected reserve | 51 / 45 | 53 / 49 | 5,000 / inherited | 4,947 ms | comfortable |
| cancellation preserves source facts | 79 / 69 | 86 / 77 | 5,000 / inherited | 4,914 ms | comfortable |
| scan unacknowledged obligations | 24 / 23 | 34 / 25 | 5,000 / inherited | 4,966 ms | comfortable |
| due alarm leaves source enumerable | 58 / 62 | 69 / 61 | 5,000 / inherited | 4,931 ms | comfortable |
| poison retry does not starve sibling | 139 / 121 | 162 / 130 | 5,000 / inherited | 4,838 ms | comfortable |
| minimum due-time scheduler | 94 / 81 | 98 / 87 | 5,000 / inherited | 4,902 ms | comfortable |
| inserted obligation re-arms | 38 / 33 | 45 / 39 | 5,000 / inherited | 4,955 ms | comfortable |
| crash before/after re-arm | 142 / 134 | 150 / 141 | 5,000 / inherited | 4,850 ms | comfortable |
| 33-obligation backlog / 32-row limit | 418 / 414 | 475 / 432 | 10,000 / written G79 | 9,525 ms | comfortable |
| same identity changed digest | 32 / 28 | 41 / 44 | 5,000 / inherited | 4,956 ms | comfortable |
| distinct persisted source rows | 24 / 24 | 24 / 24 | 5,000 / inherited | 4,976 ms | comfortable |
| every append cursor consumed | 22 / 23 | 25 / 28 | 5,000 / inherited | 4,972 ms | comfortable |

The abbreviated assertion labels above map one-to-one, in source order, to
the 20 titles printed by the linked job logs. The threshold is still
`duration >= 50%` of budget; no hosted row reaches it. The target backlog is
only 4.75% of its 10,000 ms budget at its slowest observation, while the
retained measurement is at most 12.84% of 60,000 ms.

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

The hosted terminal receipts for the two red results are recorded with the
exact run/job identity. Both exact-head hosted attempts returned the required
`both-red` result in both the normal and forced-red invocations:

| attempt | hosted log timestamps | result |
| --- | --- | --- |
| 1 | 02:07:28Z and 02:11:21Z | `shrink-backlog-below-alarm-budget: red`; `remove-rearm-assertion: red` |
| 2 | 02:52:05Z and 02:56:04Z | `shrink-backlog-below-alarm-budget: red`; `remove-rearm-assertion: red` |

The receipts are in the linked `ci-g43` job logs above. Local execution also
returned `both-red`, but it is not substituted for the hosted evidence.

## Before/after wall-clock cost

The baseline workflow and `ci-g43` durations above are the before receipts.
The two after receipts are terminal green runs at the same exact head:

| receipt | workflow wall-clock | `ci-g43` wall-clock | result |
| --- | ---: | ---: | --- |
| main [34418417311](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34418417311) | 35 m 44 s | 8 m 04 s | green |
| G79 [34427912295 attempt 1](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295) | 41 m 50 s | 8 m 09 s | green |
| G79 [34427912295 attempt 2](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/attempts/2) | 43 m 21 s | 8 m 17 s | green |

The whole-workflow increase is in the existing long G30/G32/forced-red lanes;
the G43 lane itself increased by only 5–13 seconds while adding assertion
receipts and the two red-mutant proofs. The selected 10,000 ms budget is
therefore based on the measured 5,121 ms PR #158 failure and the genuine 33
obligation/SQL/alarm work, not on a CI anecdote or on changing a production
guard.

## Scope and missing evidence

Only the G43 test budget, G43-lane timing reporter, G79 mutation runner, and
this evidence are in scope. There is no product-code change, no G43 repair,
no assertion removal, no skip/flaky annotation, no CI timeout inflation, and
no change to PR #158. All required G79 hosted assertion-level, repeated-run,
mutation, and after-calibration receipts are present in the linked exact-head
logs. Historical main receipts did not expose assertion-level durations, so
the before comparison is honestly limited to their file/suite and workflow
clocks; no per-test main value is inferred.

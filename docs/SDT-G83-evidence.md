# SDT-G83 hosted budget evidence

This document records the SDT-G83 measure-before-choice process for issue #167. The scope is the five amended budget-edge tests below. The G67 AC3 safe-lane test is explicitly out of scope for this unit because SDT-G80 owns it. No product source, global Vitest timeout, unrelated budget, lane order, retry, skip, or flaky annotation is changed here.

## AC1: predeclared hosted measurement plan

The plan was declared in the first dedicated-branch commit before M1 began:

- Repository: `J-Tech-Japan/sekiban-dcb-ts`.
- Base: `origin/main` at `fc35a382bc67ac930776a5a6b52ae10699ce972d`.
- Measurement source: the PR #173 workflow for source head `4e1a949b0f493e71811423d4368a1ae5e6e0c908`, workflow `34678103960`.
- Initial PR attempt 1 foundation job: `103511507644`. The main baseline job `103509892567` in run `34675690179` is historical comparison evidence; it was not rerun.
- M1, M2 and M3 are three fresh `gh run rerun --job` invocations of the PR foundation job, declared before M1. No whole workflow or unrelated job was dispatched.
- Every receipt retains workflow attempt, job ID, job URL, source head, Vitest/npm-test phase total, and all five named observations. A timed-out observation remains **censored** and is never used as a work-cost estimate. Each selected foundation job consumed about eight billable minutes.

The first declaration text called the historical main job the source job. The receipt correction above is authoritative: all three fresh measurements reran PR job `103511507644`, not the historical main job.

## Historical baseline

Main run [34675690179](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34675690179) at `fc35a382bc67ac930776a5a6b52ae10699ce972d`, foundation job `103509892567`, recorded an npm-test phase of 205.6 seconds and six timeout failures. The five in-scope observations were censored at their applicable budgets: AC7 at 3,000 ms, G5 at 3,000 ms, Branch B at the inherited 5,000 ms, the six-boundary repair test at 15,000 ms, and G69 MV at the inherited 5,000 ms. G67 AC3 also timed out at 10,000 ms, but is excluded from this unit. The historical censored values are retained as failure evidence, not treated as measurements from which to enlarge a budget.

The initial PR workflow [34678103960](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960) at source head `4e1a949b0f493e71811423d4368a1ae5e6e0c908` was green on its initial attempt: foundation `103511507644`, cheap `103511507534`, and verify `103513095766`. Its foundation job was the exact job subsequently rerun for M1--M3.

The M1--M3 observations below were collected before the bounded per-test calibration in this PR and therefore retain the original budgets at those receipts. They are still the declared hosted measurement set; the calibration decision uses those uncensored observations together with the historical accepted slow-runner sample and keeps every censored value censored.

## Fresh exact-head measurements

The GitHub run API reports source head `4e1a949b0f493e71811423d4368a1ae5e6e0c908` for all three attempts. The older reporter emitted the synthetic pull-request merge ref `438475339fcd8c92459929880688c7e6c24f8e96` as `GITHUB_SHA`; that is recorded as an implementation-era provenance detail, not mistaken for the PR source head. The repaired reporter reads the pull-request head from the event payload for subsequent receipts.

### Job receipts and phase totals

| Receipt | Workflow attempt | Foundation job | Job wall time | Vitest/npm-test phase | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| M1 | 2 | [103513609862](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960/job/103513609862) | 7m36s | 158,223 ms | success |
| M2 | 3 | [103514602123](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960/job/103514602123) | 7m29s | 156,470 ms | success |
| M3 | 4 | [103515524497](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960/job/103515524497) | 7m39s | 157,604 ms | success |

Each phase summary reported 834 tests, zero failed tests, and one unrelated censored observation. The selected five rows were present and uncensored in each receipt:

| Named test (source location) | Budget selected by this PR | M1 ms / margin | M2 ms / margin | M3 ms / margin | Disposition |
| --- | --- | ---: | ---: | ---: | --- |
| `commit.spec.ts:556` AC7 allocation/cancellation facts | 5,000 ms; was explicit `}, 3_000);` at line 621 | 946 / 4,054 | 903 / 4,097 | 988 / 4,012 | comfortable; bounded calibration |
| `tag.spec.ts:401` G5 exact-key fence ordering | 5,000 ms; was explicit `}, 3_000);` at line 519 | 1,069 / 3,931 | 1,010 / 3,990 | 1,070 / 3,930 | comfortable; bounded calibration |
| `repair.spec.ts:481` Branch B exclusion binding | 10,000 ms; was Vitest inherited default 5,000 ms | 786 / 9,214 | 754 / 9,246 | 821 / 9,179 | comfortable; bounded calibration |
| `repair.spec.ts:410` six crash/race boundaries | 20,000 ms; was explicit `}, 15_000);` at line 432 | 3,482 / 16,518 | 3,416 / 16,584 | 3,010 / 16,990 | comfortable; bounded calibration |
| `g69-ordering.spec.ts:595` real MV generations/join commit | 10,000 ms; was Vitest inherited default 5,000 ms | 521 / 9,479 | 510 / 9,490 | 550 / 9,450 | comfortable; bounded calibration |

Margins are budget minus observed duration. Against the calibrated ceilings, the maximum observed utilization is 17.4% for the six-boundary test, 21.4% for G5, 19.8% for AC7, 8.2% for Branch B, and 5.5% for G69. All are comfortably below the 50% near-budget threshold in all three fresh runs; the pre-calibration receipt below explains why the old ceilings were not retained.

## AC2: budget origins and work basis

| Test | Exact budget source | Origin evidence | Work basis used for the decision |
| --- | --- | --- | --- |
| AC7 | Per-test 5,000 ms | original 3,000 ms option from G73 commit `809d535ee93e2318b46234db47ffb2d94b1949a1`; selected here after the repeated hosted slow-runner boundary | one allocation/cancellation fault injection, allocator/tag fact inspection, and direct Section 6 response; fresh observations 0.90--0.99 s, accepted moderate sample 2.164 s, with a bounded 5,000 ms ceiling |
| G5 | Per-test 5,000 ms | original 3,000 ms option from G73 commit `809d535ee93e2318b46234db47ffb2d94b1949a1`; selected here after the repeated hosted slow-runner boundary | exact-key fence install/clear/append ordering, acknowledgement, and unrelated-fence checks; fresh observations 1.01--1.07 s, accepted moderate sample 2.079 s, with a bounded 5,000 ms ceiling |
| Branch B | Per-test 10,000 ms | no written option before this PR; it inherited Vitest's 5,000 ms default, with no `testTimeout` in the applicable config; selected here after 5,082--5,238 ms censored incident boundaries | one provider-exclusion repair, stable Tag head/version assertions, and public repair response; fresh observations 0.75--0.82 s, accepted moderate sample 1.574 s, with a bounded 10,000 ms ceiling |
| Six boundaries | Per-test 20,000 ms | original 15,000 ms option from G32 commit `9e897754545c92404c0a52cca6325312dab11918`; selected here after the widened 15,239 ms censored incident boundary | six sequential crash/race observations, durable Tag re-queries, and convergence without `Response.error`; fresh observations 3.01--3.48 s, with a bounded 20,000 ms ceiling and no claim that a censored 15,239 ms value is work cost |
| G69 MV | Per-test 10,000 ms | no written option before this PR; it inherited Vitest's 5,000 ms default, with no `testTimeout` in `vitest.g69.config.ts`; selected here after the widened 8,054 ms censored incident boundary | real materialized-view generations, join commit delivery, and public safe-reader status across the ordering schedule; fresh observations 0.51--0.55 s, with a bounded 10,000 ms ceiling |

The repeated uncensored observations show the work itself is short on a normal runner; they do not make the old ceilings adequate on the recorded slow runners. The final exact-head pre-calibration workflow below reproduced the same timeout boundary for three in-scope tests, so this PR makes only the five named per-test ceilings explicit/bounded: 5,000 ms for AC7 and G5, 10,000 ms for Branch B and G69, and 20,000 ms for the six-boundary test. These ceilings are selected from the normal distribution, the accepted 71.5-second moderate slowdown sample and the observed incident slowdown range; the censored samples remain censored and are not represented as work cost. No G67 budget was inspected as a candidate or changed. The reporter emits the same source location, budget source/origin, work basis, duration, margin and censored classification for future hosted receipts.

## AC3/AC4: five behavioral mutants

`npm run test:g83:budgets` runs the five named controls, then `scripts/g83-budget-mutation-runner.mjs`. The runner uses one exact named Vitest oracle per mutation, records status/signal/spawn error, requires a structured report with exactly one failed named assertion and the expected boundary values, rejects timeout/setup/import/database/signal/missing-target/unrelated failures, and restores the source in `finally`. Its self-test rejects green, missing-report, signal, spawn-error, timeout, setup/import/database, missing-target and unrelated-assertion records.

| Mutant | Scoped change | Named oracle / structured failure | Result |
| --- | --- | --- | --- |
| `commit-ac7-fault-path` | `journal-cas-after-allocator` -> mutant fault marker | AC7 allocation/cancellation facts; `expected 200 to be 504` at `test/commit.spec.ts:565` | red, status 1, null signal, one failed test; control green and source restored |
| `tag-g5-clear-key` | final `repair-b` clear key -> mutant key | G5 exact-key fence ordering; `expected 500 to be 201` at `test/tag.spec.ts:479` | red, status 1, null signal, one failed test; control green and source restored |
| `repair-branch-b-binding-status` | fake exclusion binding 204 -> 500 | Branch B exclusion binding; named public response assertion `expected 500 to be 200` | red, status 1, null signal, one failed test; control green and source restored |
| `repair-six-boundary-fault` | `after-clear-before-final-observation` -> mutant fault marker | six crash/race boundaries; `expected 200 to be 202` at `test/repair.spec.ts:422` | red, status 1, null signal, one failed test; control green and source restored |
| `g69-safe-reader-substitution` | safe public read -> unsafe public read | real MV generations/safe reader; `expected 200 to be 503` at `test/g69-ordering.spec.ts:657` | red, status 1, null signal, one failed test; control green and source restored |

The four source files and all mutation anchors were checked unique before execution. The mutation runner leaves the 33/32/re-arm G43 proof and the G67 AC3 proof untouched; no timeout or timing assertion was used as a mutation oracle.

## AC5: implementation, CI and scope receipts

- Issue claim was completed before source work with the canonical `intent-cli worker claim --kind issue --number 167 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write --format json` command (`proceed=true`, `applied=true`).
- Dedicated branch: `claude/sdt-g83-hosted-budgets-w259`, based on the exact main SHA above. PR [#173](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/173) is against `main` and retains `Closes #167`. The canonical `worker complete --kind issue --number 167 --repo J-Tech-Japan/sekiban-dcb-ts --pr 173 --outcome pr-created --github-only --write --format json` receipt succeeded immediately after PR creation.
- The initial PR workflow and M1--M3 are historical measurement receipts; the final implementation push and exact-head workflow are recorded below.
- `git merge-base --is-ancestor fc35a382bc67ac930776a5a6b52ae10699ce972d` succeeds for the final branch. No product runtime source, G67 AC3, global timeout, unrelated lane, retry, skip, or flaky annotation is changed.

### Pre-calibration exact-head diagnostic

PR workflow [34680166909](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34680166909) ran at source head `53110eb3d12aa1ffd20213abd3dd575482e6274a` before the bounded calibration. Its [foundation job 103517266180](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34680166909/job/103517266180) failed in the unchanged full `npm test` invocation after 281,401 ms: AC7 timed out at its old 3,000 ms ceiling, the six-boundary repair test timed out at its old 15,000 ms ceiling, and the G67 AC3 test timed out at 10,000 ms. The first two are censored G83 observations, not work-cost measurements; G67 remains explicitly out of scope. The [cheap job 103517266045](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34680166909/job/103517266045) independently failed because the temporary G83 manifest command made the existing G40 inventory expect 132 additions but observe 133; the temporary manifest command was removed, while the local `test:g83:budgets` package command remains available. [Verify job 103519016127](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34680166909/job/103519016127) correctly reported the dependency failures. No product assertion failed and no G67/global timeout was changed.

The bounded repair therefore changes only the five named G83 per-test ceilings and removes the temporary manifest wiring that was not required by the issue: AC7 3,000 -> 5,000 ms, G5 3,000 -> 5,000 ms, Branch B inherited 5,000 -> explicit 10,000 ms, six boundaries 15,000 -> 20,000 ms, and G69 inherited 5,000 -> explicit 10,000 ms. No other budget, lane, workflow, test body, retry, skip or flaky annotation moves.

## Final implementation receipt

The calibrated implementation source head is `6947b29d33377d308c2f179e3a53113428ab0871` on base `fc35a382bc67ac930776a5a6b52ae10699ce972d`. Its normal push-triggered PR workflow [34681164059](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34681164059) was terminal `success` at that exact head; no workflow-dispatch run or job rerun beyond the predeclared M1--M3 measurements was used.

| Job | Receipt | Terminal result |
| --- | --- | --- |
| `ci-foundation` | [103519941730](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34681164059/job/103519941730) | success; 7m55s; full `npm test` 164,072 ms; 98 files passed, 1 skipped; 833 tests passed, 1 skipped; no failed tests |
| `ci-pr-cheap` | [103519941845](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34681164059/job/103519941845) | success; manifest PR-cheap/G40 checks passed |
| `verify` | [103521269237](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34681164059/job/103521269237) | success; dependency gate passed |

The final foundation timing summary reported `durationMs: 164072`, `testCount: 834`, `failedCount: 0`, and `censoredCount: 1`; the one censored observation was unrelated to the five selected G83 tests. The selected final-head observations were all uncensored and passed: AC7 `test/commit.spec.ts:556` 1,276 ms under 5,000 ms; G5 `test/tag.spec.ts:401` 1,157 ms under 5,000 ms; Branch B `test/repair.spec.ts:481` 1,041 ms under 10,000 ms; six crash/race boundaries `test/repair.spec.ts:410` 3,499 ms under 20,000 ms; and G69 real MV generations/join commit `test/g69-ordering.spec.ts:595` 668 ms under 10,000 ms. The five budgets remain the bounded, evidence-backed choices described above; G67 AC3 remains unchanged and out of scope.

The same exact head passed the release preflight [34681164050](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34681164050), including [job 103519941438](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34681164050/job/103519941438). The preflight completed successfully through the package, consumer, release-check and credential-free dry-run steps. These receipts are terminal; no additional workflow dispatch or job rerun is part of this unit.

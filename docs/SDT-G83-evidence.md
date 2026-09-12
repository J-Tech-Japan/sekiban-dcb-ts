# SDT-G83 hosted budget evidence

This document records the SDT-G83 measure-before-choice process for issue #167. The scope is the five amended budget-edge tests below. The G67 AC3 safe-lane test is explicitly out of scope for this unit because SDT-G80 owns it. No product source, global Vitest timeout, unrelated budget, lane order, retry, skip, or flaky annotation is changed here.

## AC1: predeclared hosted measurement plan

The plan was declared in the first dedicated-branch commit before M1 began:

- Repository: `J-Tech-Japan/sekiban-dcb-ts`.
- Base: `origin/main` at `fc35a382bc67ac930776a5a6b52ae10699ce972d2`.
- Measurement source: the PR #173 workflow for source head `4e1a949b0f493e71811423d4368a1ae5e6e0c908`, workflow `34678103960`.
- Initial PR attempt 1 foundation job: `103511507644`. The main baseline job `103509892567` in run `34675690179` is historical comparison evidence; it was not rerun.
- M1, M2 and M3 are three fresh `gh run rerun --job` invocations of the PR foundation job, declared before M1. No whole workflow or unrelated job was dispatched.
- Every receipt retains workflow attempt, job ID, job URL, source head, Vitest/npm-test phase total, and all five named observations. A timed-out observation remains **censored** and is never used as a work-cost estimate. Each selected foundation job consumed about eight billable minutes.

The first declaration text called the historical main job the source job. The receipt correction above is authoritative: all three fresh measurements reran PR job `103511507644`, not the historical main job.

## Historical baseline

Main run [34675690179](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34675690179) at `fc35a382bc67ac930776a5a6b52ae10699ce972d2`, foundation job `103509892567`, recorded an npm-test phase of 205.6 seconds and six timeout failures. The five in-scope observations were censored at their applicable budgets: AC7 at 3,000 ms, G5 at 3,000 ms, Branch B at the inherited 5,000 ms, the six-boundary repair test at 15,000 ms, and G69 MV at the inherited 5,000 ms. G67 AC3 also timed out at 10,000 ms, but is excluded from this unit. The historical censored values are retained as failure evidence, not treated as measurements from which to enlarge a budget.

The initial PR workflow [34678103960](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960) at source head `4e1a949b0f493e71811423d4368a1ae5e6e0c908` was green on its initial attempt: foundation `103511507644`, cheap `103511507534`, and verify `103513095766`. Its foundation job was the exact job subsequently rerun for M1--M3.

## Fresh exact-head measurements

The GitHub run API reports source head `4e1a949b0f493e71811423d4368a1ae5e6e0c908` for all three attempts. The older reporter emitted the synthetic pull-request merge ref `438475339fcd8c92459929880688c7e6c24f8e96` as `GITHUB_SHA`; that is recorded as an implementation-era provenance detail, not mistaken for the PR source head. The repaired reporter reads the pull-request head from the event payload for subsequent receipts.

### Job receipts and phase totals

| Receipt | Workflow attempt | Foundation job | Job wall time | Vitest/npm-test phase | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| M1 | 2 | [103513609862](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960/job/103513609862) | 7m36s | 158,223 ms | success |
| M2 | 3 | [103514602123](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960/job/103514602123) | 7m29s | 156,470 ms | success |
| M3 | 4 | [103515524497](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34678103960/job/103515524497) | 7m39s | 157,604 ms | success |

Each phase summary reported 834 tests, zero failed tests, and one unrelated censored observation. The selected five rows were present and uncensored in each receipt:

| Named test (source location) | Budget and origin | M1 ms / margin | M2 ms / margin | M3 ms / margin | Disposition |
| --- | --- | ---: | ---: | ---: | --- |
| `commit.spec.ts:556` AC7 allocation/cancellation facts | 3,000 ms; explicit `}, 3_000);` at line 621 | 946 / 2,054 | 903 / 2,097 | 988 / 2,012 | retain; comfortable |
| `tag.spec.ts:401` G5 exact-key fence ordering | 3,000 ms; explicit `}, 3_000);` at line 519 | 1,069 / 1,931 | 1,010 / 1,990 | 1,070 / 1,930 | retain; comfortable |
| `repair.spec.ts:481` Branch B exclusion binding | 5,000 ms; no written option, Vitest inherited default | 786 / 4,214 | 754 / 4,246 | 821 / 4,179 | retain inherited default; comfortable |
| `repair.spec.ts:410` six crash/race boundaries | 15,000 ms; explicit `}, 15_000);` at line 432 | 3,482 / 11,518 | 3,416 / 11,584 | 3,010 / 11,990 | retain; comfortable |
| `g69-ordering.spec.ts:595` real MV generations/join commit | 5,000 ms; no written option, Vitest inherited default | 521 / 4,479 | 510 / 4,490 | 550 / 4,450 | retain inherited default; comfortable |

Margins are budget minus observed duration. The maximum observed utilization is 35.0% for the six-boundary test, 35.7% for G5, 32.9% for AC7, 16.4% for Branch B, and 11.0% for G69. All are below the 50% near-budget threshold in all three fresh runs.

## AC2: budget origins and work basis

| Test | Exact budget source | Origin evidence | Work basis used for the decision |
| --- | --- | --- | --- |
| AC7 | Per-test 3,000 ms | G73 commit `809d535ee93e2318b46234db47ffb2d94b1949a1`, `test/commit.spec.ts` | one allocation/cancellation fault injection, allocator/tag fact inspection, and direct Section 6 response |
| G5 | Per-test 3,000 ms | G73 commit `809d535ee93e2318b46234db47ffb2d94b1949a1`, `test/tag.spec.ts` | exact-key fence install/clear/append ordering, acknowledgement, and unrelated-fence checks |
| Branch B | Vitest inherited default 5,000 ms | no per-test option at `test/repair.spec.ts:481`; no `testTimeout` in the applicable config | one provider-exclusion repair, stable Tag head/version assertions, and public repair response |
| Six boundaries | Per-test 15,000 ms | G32 commit `9e897754545c92404c0a52cca6325312dab11918`, `test/repair.spec.ts` | six sequential crash/race observations, durable Tag re-queries, and convergence without `Response.error` |
| G69 MV | Vitest inherited default 5,000 ms | no per-test option at `test/g69-ordering.spec.ts:595`; no `testTimeout` in `vitest.g69.config.ts` | real materialized-view generations, join commit delivery, and public safe-reader status across the ordering schedule |

The repeated uncensored observations show that these five bodies are not genuinely expensive work at the selected budgets. Therefore all five budgets are retained, including the two inherited defaults, with explicit work bases instead of changing a budget to hide the historical runner slowdown. No G67 budget was inspected as a candidate or changed. The reporter emits the same source location, budget source/origin, work basis, duration, margin and censored classification for future hosted receipts.

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

## Final implementation receipt

This section is completed after the scoped implementation/evidence push and its normal PR workflow reaches terminal state. It must name the final source head, workflow/job URLs, and terminal conclusions; no workflow-dispatch run or job rerun beyond M1--M3 is part of this unit.

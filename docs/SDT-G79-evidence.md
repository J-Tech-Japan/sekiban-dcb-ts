# SDT-G79 hosted budget evidence

Task: `SDT-G79-HOSTED-BUDGET-CALIBRATION-W204`, with the W207 review repair
and W209 measurement-coverage repair recorded below.

This document records the measurement and proof for the G43 hosted test lane,
the W207 all-lane invocation inventory, and the W209 all-lane per-test
measurement coverage and G46 receipt correction.
It does not change product behavior or the G43 proof boundary. The held PR
#158 and `test/g43-tag-sql.spec.ts` on that PR were not modified or rerun for
this unit.

W207/W209 review repair scope is limited to measurement inventory, supported
per-test timing receipts, structured mutation-result validation, receipt
provenance, and this evidence. The G43
33-obligation body, SQL `LIMIT 32`, re-arm assertion, and all G43 coordination
and production sources are unchanged.

## Measure-first baseline

The branch was based on `origin/main` at
`809d535ee93e2318b46234db47ffb2d94b1949a1`. Before the G79 source change, the
available main receipts showed the G43 lane's file and suite cost below. The
existing W207 hosted reporter did not emit assertion-level durations for
the other CI lanes, so those receipts cannot honestly be used as per-test
measurements. W209 adds a supported Vitest reporter at the shared invocation
boundary and wires it through the default and alternate Vitest configs; the
hosted plan below measures every Vitest invocation, not just G43. Non-Vitest
proof commands remain inventory rows but have no invented test-body duration.

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
| Other 18 assertions in the G43 lane | 5,000 ms, Vitest inherited default | No budget is changed. Each assertion is emitted by the hosted timing report; every measured near-budget result would be named there, while comfortable results remain on the inherited default. A green anecdote is not used as the basis for the selected 10,000 ms budget. |

The W209 reporter is complete for each Vitest invocation that loads one of the
instrumented configs. `scripts/g79-ci-inventory.mjs` inventories every
test/proof command declared in the existing hosted workflow, resolves nested
`npm run` scripts, and labels each row either
`per-test-reporter-required` or `proof-only-no-test-cases`. This prevents an
unmeasured lane from being silently called comfortable.

## AC1 per-test hosted receipts and provenance

The G79 timing reporter is wired into `npm run test:g43` and prints one
`SDT-G79_HOSTED_TEST_TIMING` JSON line for each of the 20 assertions. W207
also records `commitSha`, `sourceReceiptClass`, `workflowRunId`,
`workflowAttempt`, `hosted job`, and `invocation`. A workflow attempt is one
hosted workflow execution; a normal and a forced-red command inside its
`ci-g43` job are two invocations, not two workflow attempts. The historical
logs predate those fields, so their actual source SHA and invocation labels
are recorded explicitly below from the immutable run/job receipts.

The first table is historical source-head evidence. Both workflow attempts
ran source commit `21427a58534efe8af4b3553322268f84fd6cbbd6` (`21427a5`), not
the later reviewed docs head.

| exact-head hosted run | `ci-g43` job | terminal result |
| --- | --- | --- |
| [34427912295 attempt 1](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295) — `commitSha=21427a58534efe8af4b3553322268f84fd6cbbd6`, `workflowAttempt=1`, invocations `normal`/`forced-red` | [102716974790](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/job/102716974790) | green |
| [34427912295 attempt 2](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/attempts/2) — `commitSha=21427a58534efe8af4b3553322268f84fd6cbbd6`, `workflowAttempt=2`, invocations `normal`/`forced-red` | [102725811608](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/job/102725811608) | green |

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

The next table is the distinct reviewed-head receipt that W204 called the
“final docs-head workflow”. Its source commit was
`cd15a2729ea2aa062515012ad1938266856ede2b` (`cd15a27`), and its only source
difference from `21427a5` was documentation. It is therefore a
`reviewed-head-cd15a27-docs-only-equivalent`, not a rename of the historical
receipts. The linked job is one workflow attempt; its two columns are two
invocations inside that job (`normal` then `forced-red`).

| assertion (source order) | `normal` ms | `forced-red` ms | budget / source | minimum margin | classification |
| --- | ---: | ---: | --- | ---: | --- |
| golden digest | 5 | 8 | 5,000 / inherited | 4,992 ms | comfortable |
| duplicate/reordered tags | 2 | 2 | 5,000 / inherited | 4,998 ms | comfortable |
| non-projected field fails closed | 0 | 1 | 5,000 / inherited | 4,999 ms | comfortable |
| distinct event identities | 1 | 0 | 5,000 / inherited | 5,000 ms | comfortable |
| real Tag-DO SQL measurement | 7,278 | 8,623 | 60,000 / retained explicit | 51,377 ms | comfortable |
| invalid measurement shapes | 8 | 18 | 5,000 / inherited | 4,982 ms | comfortable |
| commit five normalized facts | 67 | 63 | 5,000 / inherited | 4,937 ms | comfortable |
| rollback five facts | 31 | 30 | 5,000 / inherited | 4,969 ms | comfortable |
| first-write identity/rejected reserve | 57 | 50 | 5,000 / inherited | 4,943 ms | comfortable |
| cancellation preserves source facts | 103 | 80 | 5,000 / inherited | 4,897 ms | comfortable |
| scan unacknowledged obligations | 29 | 26 | 5,000 / inherited | 4,971 ms | comfortable |
| due alarm leaves source enumerable | 86 | 65 | 5,000 / inherited | 4,914 ms | comfortable |
| poison retry does not starve sibling | 172 | 131 | 5,000 / inherited | 4,828 ms | comfortable |
| minimum due-time scheduler | 96 | 90 | 5,000 / inherited | 4,904 ms | comfortable |
| inserted obligation re-arms | 41 | 40 | 5,000 / inherited | 4,959 ms | comfortable |
| crash before/after re-arm | 161 | 184 | 5,000 / inherited | 4,816 ms | comfortable |
| 33-obligation backlog / 32-row limit | 491 | 399 | 10,000 / written G79 | 9,509 ms | comfortable |
| same identity changed digest | 35 | 37 | 5,000 / inherited | 4,963 ms | comfortable |
| distinct persisted source rows | 28 | 26 | 5,000 / inherited | 4,972 ms | comfortable |
| every append cursor consumed | 26 | 25 | 5,000 / inherited | 4,974 ms | comfortable |

Receipt: [34433781998](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998),
`workflowAttempt=1`, [ci-g43 job 102734555400](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555400).
The old reporter did not print the SHA fields; W207 labels the receipt with
the exact PR head verified by the workflow checkout and preserves its original
run/job identity. New receipts from this repair use the fields directly.

The abbreviated assertion labels above map one-to-one, in source order, to
the 20 titles printed by the linked job logs. The threshold is still
`duration >= 50%` of budget; no hosted row reaches it. The target backlog is
only 4.75% of its 10,000 ms budget at its slowest observation, while the
retained measurement is at most 12.84% of 60,000 ms.

### W207 repair-head hosted receipt

The W207 repair-head workflow is [34442088611](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34442088611), attempt 1. Its `ci-g43` receipt is [job 102759071652](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34442088611/job/102759071652). The reporter and inventory emit both identities: `commitSha=b1602ecec1be702fe789cdd9443b608954b730e0` is the actual PR source head, and `workflowCheckoutSha=24380261a59ea828d92c355c59f62c52f0b8472f` is the synthetic pull-request merge checkout tested by Actions. This is an explicit source-head/checkout distinction, not a renamed receipt.

| invocation inside `ci-g43` | hosted timing receipt | test count / near-budget set | selected budgeted rows |
| --- | --- | --- | --- |
| `normal` | `commitSha=b1602ec…`, `workflowRunId=34442088611`, `workflowAttempt=1`, `job=ci-g43` | 20; `nearBudget=[]` | G43 AC6 `453 ms`, margin `9,547 ms`; structural measurement `6,609 ms`, margin `53,391 ms` |
| `forced-red` | same source/run/job identity, invocation `forced-red` | 20; `nearBudget=[]` | G43 AC6 `409 ms`, margin `9,591 ms`; structural measurement `6,928 ms`, margin `53,072 ms` |

Both repair-head G43 invocations passed, and the same job emitted the required
`all-five-production-mutants-red` receipt plus the G79 `both-red` receipt. The
normal and forced-red mutation runs each recorded the named AC6 assertion
failing at the SQL `LIMIT 32` boundary (`expected 32`, `observed 31`) for the
shrink mutant, while the re-arm mutation remained the labelled source-shape
oracle. The release preflight [34442088607](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34442088607) for this source head is green. The full repair-head workflow [34442088611](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34442088611) reached terminal `success`; all 21 jobs, including aggregate `verify` job `102768258394`, passed. The workflow ran from `05:41:33Z` to `06:26:03Z` (44m30s).

The earlier source-repair workflow [34440729757](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34440729757) at `63869ea` reached terminal `failure` only in the unrelated `ci-g44` lane: its first concrete error was G62 AC1 at `test/g62-global-completeness.spec.ts:251`, receiving `UNKNOWN` instead of `FULL`, followed by G62 AC2/AC3 and G67 AC1/AC4 green-oracle failures. G79 foundation/G43 receipts were green. This first-error provenance is retained as out-of-scope evidence; the corrected-SHA run above passed the same G44 lane without any G79 change to G62/G67 behavior.

## W207 F1 — all hosted CI-lane invocations and measurement coverage

The existing CI workflow has 21 jobs including the aggregate `verify` job.
The W207 inventory parser reads only `.github/workflows/ci.yml` and emits one
row for every test/proof command it finds, including forced-red invocations;
the reviewed workflow contains 126 such rows. The table below preserves the
hosted run/job receipts and the command-row count. The linked run was the
reviewed `cd15a27` docs-only equivalent, `workflowAttempt=1`; the job IDs are
not being conflated with invocation numbers.

| hosted job | hosted job receipt | inventory rows | per-test timing status | budget location / checkable basis |
| --- | --- | ---: | --- | --- |
| `ci-foundation` | [102734555266](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555266) | 8 | partial: named G67/repair receipts only | G67 AC3 `test/g67-safe-lane.spec.ts:856` 10,000 ms; remaining foundation tests inherit Vitest default; no universal assertion receipt |
| `ci-g28` | [102734555138](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555138) | 12 | missing | compile/boundary work is inventoried; no supported per-test hosted duration or margin receipt |
| `ci-g64` | [102734555236](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555236) | 3 | missing | publish/trusted-publishing checks are inventoried; no per-test duration receipt |
| `ci-g21-g25` | [102734555311](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555311) | 16 | missing | G21–G25/G53–G56 invocations are inventoried; no per-test duration receipt |
| `ci-g26-g27` | [102734554972](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734554972) | 9 | missing | G26/G27/G60/G65 invocations are inventoried; no per-test duration receipt |
| `ci-g29` | [102734555305](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555305) | 15 | missing | G29 mapping/delivery/diagnostic/authoring/witness invocations are inventoried; no per-test duration receipt |
| `ci-g31` | [102734555276](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555276) | 2 | missing | G31 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-g32-parity` | [102734555390](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555390) | 2 | missing | G32 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-g30-core` | [102734555344](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555344) | 4 | missing | G30/G51/candidate invocations are inventoried; no per-test duration receipt |
| `ci-g30-forced-red` | [102734555181](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555181) | 1 | missing | G30 forced-red invocation is inventoried; no per-test duration receipt |
| `ci-g38` | [102734555282](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555282) | 2 | missing | G38 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-g42` | [102734555355](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555355) | 2 | missing | G42 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-g43` | [102734555400](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555400) | 2 | complete | G79 JSON reporter covers all 20 assertions; G43 AC6 10,000 ms and measurement 60,000 ms are source-located |
| `ci-g44` | [102734555199](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555199) | 11 | partial: named G67 receipt only | G67 AC3 10,000 ms is source-located; G44/G58/G62/G61 rows lack universal per-test receipts |
| `ci-g45` | [102734555351](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555351) | 2 | missing | G45 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-g46` | [102734555212](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555212) | 4 | partial named assertion receipts | the named G43 measurement assertion is available; neighboring G46 assertions were not universally reported by the W207 command |
| `ci-g41` | [102734555288](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555288) | 2 | missing | G41 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-local-e2e` | [102734555345](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555345) | 8 | missing | store/D1/MV/consumer/build/E2E invocations are inventoried; no per-test hosted duration receipt |
| `cosmos-emulator` | [102734555357](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555357) | 17 | missing | Cosmos/G20/G22/G26–G32 candidate invocations are inventoried; no per-test hosted duration receipt |
| `ci-coverage` | [102734555391](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555391) | 3 | missing | G40 coverage/negative/needs checks are inventoried; no per-test duration receipt |
| `verify` | [102742377068](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102742377068) | 1 | aggregate only | required aggregate status, not a test-body budget |

The accessible [102734555212 log](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555212) records the named assertion `consumes the packet-owned measurement spec with real Tag DO SQL transitions and a closed range-plan predicate` at `10,553 ms` and `7,742 ms` in its two observed executions. The neighboring `10,568 ms` and `7,752 ms` values are the two file totals, not assertion durations. These named rows are partial G46 per-test evidence; they do not establish universal JSON coverage for the W207 command, and no margin is inferred for the remaining G46 tests.

The same 21-job/126-invocation inventory was emitted again by the W207 repair
head in [34442088611](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34442088611), with `commitSha=b1602ecec1be702fe789cdd9443b608954b730e0`, `workflowCheckoutSha=24380261a59ea828d92c355c59f62c52f0b8472f`, and `workflowAttempt=1`. Its summary again classified only `ci-g43` as complete per-test JSON, `ci-foundation`/`ci-g44`/`ci-g46` as partial, and the remaining lanes as missing. The older job links above remain the reviewed-head inventory receipts; they are not relabelled as W207 attempts.

The inventory command names each exact command, so the table is not a claim
that `if ... forced-red` is a second workflow attempt. It is a second
invocation row within the same job. The hosted receipt columns above are
available in the same workflow run; the new W207 command emits the exact
`commitSha`, workflow attempt, and invocation fields in the repair receipt.

## W209 F1/F3 — complete invocation coverage and corrected G46 attribution

W209 changes only the measurement boundary and evidence. The shared CI
environment enables `SDT_G79_HOSTED_MEASURE=1`; the default, G20 alternate,
and G24 host-node Vitest configs load `scripts/g79-vitest-hosted-reporter.mjs`.
The reporter uses supported Vitest `TestCase` diagnostics and emits one JSON
receipt per collected test, including `file`, source line, full name, state,
duration, timeout, budget source/origin, work basis, and classification. A
test with no completed case receipt is emitted as `censored`; a failed case
keeps its failed duration and failure is not relabelled comfortable. The
reporter does not alter timeout values, scheduling, retries, skips, fixtures,
or product behavior.

The predeclared hosted measurement plan is:

1. Run the exact pushed head once through the full existing CI workflow and
   collect every `SDT-G79_HOSTED_TEST_TIMING` and run-summary line from all
   21 jobs. Reconcile the rows against the static 126-command inventory.
2. After the first workflow reaches terminal state, repeat the same workflow
   at the same source head as a deliberate second measurement attempt. This
   is a declared repeated measurement, not a blind rerun for a green result.
3. Aggregate by exact `(workflow run, attempt, job, invocation, file, line,
   test name)` identity. Classify each observed row as `over-budget` when
   duration exceeds its governing budget, `near-budget` at 50% or more,
   `comfortable` below 50%, and `censored` when no supported duration exists.
   Report every observed near/over row and every distinct comfortable row with
   work basis, budget origin, observed range, remaining margin, and
   disposition. Failed and censored rows remain in the denominator.

The current source inventory is 21 CI jobs and 126 command rows: 71 rows
expand to Vitest invocations covered by the reporter and 55 are proof-only
commands (guards, mutation oracles, builds, packaging, or aggregate checks).
The pre-W209 W208 run [34445256199](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34445256199)
is retained as a historical failed/censored observation even though it
predates the reporter: `ci-foundation` job `102768554508` timed out at five
unchanged tests — `commit.spec.ts:384` 5,127/5,000 ms inherited,
`commit.spec.ts:556` 3,264/3,000 ms explicit,
`g67-safe-lane.spec.ts:731` 10,008/10,000 ms explicit,
`repair.spec.ts:481` 5,173/5,000 ms inherited, and
`tag.spec.ts:401` 3,024/3,000 ms explicit. The aggregate verify job
`102778936302` failed solely because foundation failed. Those rows are not
silently called comfortable and are not treated as proof of a G79 product
defect without the repeated instrumented observations.

The budget-origin and one-line work bases for these five rows are fixed before
the plan runs:

| source row | actual governing budget | basis and W208 observation | W209 disposition rule |
| --- | --- | --- | --- |
| `test/commit.spec.ts:384` portable commit suite | 5,000 ms, Vitest inherited default | six portable commit-only admission/conflict/retry/null/concurrent-SUID paths; 5,127 ms censored by timeout | retain unless repeated completed receipts show genuinely expensive work; otherwise route the timeout as a design question |
| `test/commit.spec.ts:556` AC7 allocator/cancellation | 3,000 ms, written per-test at the closing call | allocator reservation, cancellation/tombstone, and durable fact checks; 3,264 ms | only a measured, repeated expensive-work basis permits a scoped budget change |
| `test/g67-safe-lane.spec.ts:731` AC3 | 10,000 ms, written per-test at the closing call | ten paced real D1/DO commits, queue kicks, and safe-reader convergence; 10,008 ms | retain G67 semantics and raise only if repeated supported receipts show real work rather than setup/defect |
| `test/repair.spec.ts:481` Branch B | 5,000 ms, Vitest inherited default | partial-write Branch B and provider-internal exclusion binding; 5,173 ms | a setup/runner failure is censored and routed; only genuine repeated body cost can justify an explicit scoped budget |
| `test/tag.spec.ts:401` G5 exact-key race | 3,000 ms, written per-test at the closing call | fence install/clear/append race while preserving unrelated fences; 3,024 ms | no global timeout change; retain or make a local evidence-backed decision only |

The W209 hosted receipts and final aggregate classification are appended below
with their exact workflow/job/invocation identities after the two planned
attempts. No budget is changed merely because one historical run was green or
because a file total was mistaken for an assertion duration.

## W209 terminal all-lane receipts

The predeclared repeated hosted plan completed against the W209 source head
`bffb8f29031d4f44c1162c4b80d07840592a7550` (`bffb8f2`). The workflow checkout
identity emitted by Actions was
`c388105e27d565e4cb14572f4d231dce89bb385d` (`workflowCheckoutSha`); it is kept
separate from the PR source SHA. The two attempts were:

| attempt | workflow receipt | representative jobs | terminal result / wall clock |
| --- | --- | --- | --- |
| 1 | [34451288471](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288471/attempts/1), source `bffb8f2`, [ci-foundation 102787392474](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288471/job/102787392474), [ci-g43 102787392565](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288471/job/102787392565) | full 21-job workflow plus aggregate verify `102800168810` | success; `07:42:16Z` to `08:28:08Z` (45m52s) |
| 2 | [34451288471 attempt 2](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288471/attempts/2), same source and checkout SHA, [ci-foundation 102800629912](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288471/job/102800629912), [ci-g43 102800630013](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288471/job/102800630013) | the same 21-job workflow plus aggregate verify `102813047343` | success; `08:29:33Z` to `09:12:06Z` (42m33s) |

The inventory is 21 jobs and 126 unique command rows per workflow attempt:
71 rows expand to a supported Vitest per-test reporter invocation and 55 are
proof-only commands. The G43 job prints the static inventory during both its
normal and forced-red invocations, so each log contains 252 raw inventory
lines and two summary lines; those duplicate prints are reconciled to the 126
unique rows rather than counted as extra workflow attempts. The two attempts
produced 4,350 test receipts (2,175 each), 810 distinct
`file:source-location:full-name:budget` identities, and 4,290 completed
duration observations.

The complete 810-row aggregate catalog is committed at
[`docs/SDT-G79-hosted-measurements.jsonl`](SDT-G79-hosted-measurements.jsonl).
Every row records the source/checkout identities, exact file and source
location, full test name, actual budget origin, one-line work basis, all
completed durations from the repeated plan, states, remaining margin, and the
classification/disposition. The raw per-observation receipts remain
searchable in the linked hosted job logs as `SDT-G79_HOSTED_TEST_TIMING` lines.

| aggregate classification | distinct test identities | observations / disposition |
| --- | ---: | --- |
| comfortable | 809 | 4,287 passed and 3 expected forced-red failures; retain each governing budget and no evidence-backed budget change |
| near-budget (`>=50%`) | 0 | no observed row reaches the declared threshold |
| over-budget | 0 | no completed observation exceeds its governing budget |
| censored-only | 1 | `test/g32-csharp-runtime.spec.ts:196:3`, skipped in both attempts; retain as an explicit missing duration, not comfortable |

The three failed observations are expected proof receipts inside successful
mutation/probe invocations, not production failures: the G26 topology
forced-red assertion at `test/g26-topology.spec.mjs:98:3` was `5.235688999999979`
ms in attempt 1 (`ci-g26-g27:3544`) and `4.652501999999998` ms in attempt 2
(`ci-g26-g27:3348`), and the G46 forced-red lag assertion at
`test/read.spec.ts:338:3` was `1,202` ms in attempt 1 (`ci-g46:6088`). The
workflow's mutation oracles consumed those nonzero results and every hosted
job remained green. They are retained as `failed`, not relabelled as
comfortable.

The 60 censored observations are also explicit: 58 G30 trace cases were
skipped by the existing G51 prerequisite in the two attempts, and the pinned
C# runtime test above was skipped once per attempt. No skip, retry, flaky
annotation, or lane was added by G79.

The highest observed utilization among completed aggregate identities was
still comfortable: `test/tag.spec.ts:401:3` reached 1,193/3,000 ms (1,807 ms
margin), G67 AC3 at `test/g67-safe-lane.spec.ts:731:3` reached 3,818/10,000 ms
(6,182 ms margin), the explicit AC7 allocator test at
`test/commit.spec.ts:556:3` reached 1,084/3,000 ms (1,916 ms margin), and the
retained G43 structural measurement at `test/g43-measurement.spec.ts:276:3`
reached 16,926/60,000 ms (43,074 ms margin). The catalog gives the same
work/cost/margin/disposition fields for every other comfortable identity; no
margin is inferred from a file total.

The five unchanged W208 `ci-foundation` timeouts from workflow
[34445256199](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34445256199),
job `102768554508`, remain historical pre-instrumentation observations:

| source row | W208 receipt | W209 repeated disposition |
| --- | ---: | --- |
| `test/commit.spec.ts:384` | 5,127/5,000 ms, inherited | completed at 748/792 ms; retain 5,000 ms |
| `test/commit.spec.ts:556` | 3,264/3,000 ms, written | completed at 1,041/1,084 ms; retain 3,000 ms |
| `test/g67-safe-lane.spec.ts:731` | 10,008/10,000 ms, written | completed at 3,166–3,818 ms; retain 10,000 ms and G67 semantics |
| `test/repair.spec.ts:481` | 5,173/5,000 ms, inherited | completed at 834/856 ms; retain 5,000 ms |
| `test/tag.spec.ts:401` | 3,024/3,000 ms, written | completed at 1,168/1,193 ms; retain 3,000 ms |

The W208 `verify` failure was solely downstream of foundation. None of those
five timeouts recurred as an over-budget or near-budget completed body under
the repeated W209 reporter, so no additional budget was raised and no defect
was calibrated away. The already-scoped G43 AC6 10,000 ms budget remains based
on its genuine 33-obligation/SQL-`LIMIT 32`/alarm/re-arm work and the original
5,121 ms hosted timeout receipt; it is not a global or inherited timeout.

The catalog also resolves the actual budget source for every measured row:
46 rows use written per-test options and 4,304 rows use the inherited Vitest
5,000 ms default. No CLI `--testTimeout` or config-level `testTimeout` was
present in these invocations. The source-located explicit budgets are G43 AC6
at `test/g43-tag-sql.spec.ts:494:3` (10,000 ms), G43 structural measurement
at `test/g43-measurement.spec.ts:276:3` (60,000 ms), G67 AC3 at
`test/g67-safe-lane.spec.ts:731:3` (10,000 ms), plus the existing written
options recorded in the JSONL catalog. Every retained/default budget has the
same checkable test-work basis emitted in `budgetBasis`.

## W210 release-preflight config repair

The W209 source head exposed a separate release-only configuration defect. The
old [34451288458](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288458)
run at `bffb8f29031d4f44c1162c4b80d07840592a7550` failed before tests in
`dcb-domain-release-preflight` job
[102787391246](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34451288458/job/102787391246)
at the step `Run
@sekiban/dcb-domain test suite before publish` (`npm run test:g28`). The first
Vitest error was `TypeError: Cannot read properties of undefined (reading
'length')` at `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:454`.

Commit `c9566a3c7a8e784b6923f5fda0267442045ebff4`
(`fix(g79): preserve Vitest defaults when measurement is off`) fixes only
`vitest.config.ts`, `vitest.g20.config.ts`, and
`vitest.g24-deploy.config.ts`. When `SDT_G79_HOSTED_MEASURE=1`, the configs
still spread `includeTaskLocation: true` and the hosted reporter list. When
the variable is unset, the conditional spread contributes no keys, leaving
Vitest's defaults absent rather than explicitly overwriting them with
`undefined`. The release-preflight workflow was not changed and no measuring
environment variable was added to it.

The local env-unset smoke command
`env -u SDT_G79_HOSTED_MEASURE npx vitest run test/g38-tombstone.spec.ts
--config vitest.config.ts --reporter=dot` passed 1 file / 5 tests without a
startup error. The repaired [34456219877](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34456219877)
run at `c9566a3` and job
[102803113394](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34456219877/job/102803113394)
completed `success` (`08:38:04Z`–`08:39:11Z`); the test-before-publish,
release package/consumer, pack, and credential-free dry-run steps all passed.
The repaired-head full workflow
[34456219844](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34456219844)
also completed `success` at `c9566a3`: 20 lane jobs plus aggregate `verify`
were green, including foundation job
[102803113963](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34456219844/job/102803113963)
and G43 job
[102803114055](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34456219844/job/102803114055),
from `08:38:04Z` to `09:21:43Z` (43m39s). This config repair changes no
production behavior, G43 coordination, timeout, retry, skip, or flaky policy.

### W207 historical per-test budget catalog

The checkable near-budget threshold is observed duration at least 50% of the
budget. The following table is retained as the W207 snapshot, before the
all-lane reporter was added. Its `missing` labels are historical claims about
that snapshot, not the current W209 result. The complete current catalog is
the 810-row JSONL file and the terminal logs in the W209 section above.

| test / invocation | budget location | repeated hosted observation | margin / disposition |
| --- | --- | --- | --- |
| G43 AC6 backlog | `test/g43-tag-sql.spec.ts:564`, 10,000 ms | source-head rows above (4 invocations) and reviewed-head rows above (2 invocations): 399–491 ms | 9,509 ms minimum; comfortable |
| G43 structural measurement | `test/g43-measurement.spec.ts:384`, 60,000 ms | source-head rows above: 6,619–7,703 ms; reviewed-head rows above: 7,278/8,623 ms | 51,377 ms minimum; comfortable |
| G67 AC3 ten paced commits | `test/g67-safe-lane.spec.ts:856`, 10,000 ms | [foundation job 102734555266](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555266), named test `3369 ms` | 6,631 ms; comfortable; the emitted 60,000 ms logical safe interval is domain data, not test duration |
| six-boundary repair test | `test/repair.spec.ts:432`, 15,000 ms | [foundation job 102734555266](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555266), named test `2734 ms` | 12,266 ms; comfortable |
| repair checkpoint test | `test/repair.spec.ts:452`, 10,000 ms | no named per-test receipt | missing; near/comfortable unknown |
| G45 head-facts history test | `test/g45-head-facts.spec.ts:295`, 60,000 ms | no named per-test receipt in [ci-g45 job 102734555351](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555351) | missing; near/comfortable unknown |
| G46 TagState history test | `test/g46-tagstate.spec.ts:659`, 60,000 ms | no named per-test receipt in [ci-g46 job 102734555212](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555212) | missing; near/comfortable unknown |
| downstream Queue persistence test | `test/downstream.spec.ts:278`, 15,000 ms | no named per-test receipt in the hosted `npm test` invocation | missing; near/comfortable unknown |
| Tag G5 exact-key tests | `test/tag.spec.ts:519,553`, 3,000 ms each | no named per-test receipt | missing; near/comfortable unknown |
| commit allocator/cancellation test | `test/commit.spec.ts:621`, 3,000 ms | no named per-test receipt | missing; near/comfortable unknown |

This W207 table is not used for the final W209 completeness verdict. W209
reconciles all 71 per-test-reporter invocations across the existing lanes,
names every distinct comfortable identity in the committed JSONL catalog,
retains the one censored-only identity, and reports the three expected
forced-red failures separately. The old `missing` labels are therefore
superseded, not silently reclassified from file totals.

## AC3 unchanged proof and red mutants

The final test still enqueues exactly 33 obligations, proves the source query
returns exactly 32 rows, sends 32 in the first bounded alarm pass, observes a
non-null alarm re-arm, acknowledges those 32, sends the 33rd on the next pass,
and ends with zero pending findings and a null alarm. No assertion, SQL limit,
or re-arm behavior was removed.

`scripts/g79-budget-mutation-runner.mjs` restores the source after each case
and proves both required red mutations:

1. `shrink-backlog-below-alarm-budget` changes the enqueue loop from 33 to 32
   and runs the focused real Vitest AC6 oracle with `--reporter=json` and an
   output file. The structured report names exactly the AC6 test and records
   the expected SQL `LIMIT 32` boundary assertion failing with 31 rows. (The
   smaller backlog is rejected at that earlier boundary before the tail-count
   assertion.)
2. `remove-rearm-assertion` removes the non-null re-arm assertion from a
   temporary test copy and runs the labelled AC6 proof-shape contract; the
   contract fails because the proof boundary was weakened. This is explicitly
   a source-shape oracle, not a claim that the runtime test failed.

`requireSemanticRed` fails closed unless the process is a normal nonzero exit,
the JSON report exists, exactly one assertion has the named AC6 identity, that
assertion is `failed`, and its failure message matches the SQL-32 or tail-33
boundary. It rejects a timeout, setup/import failure, signal, missing test,
zero exit, or unrelated assertion. `--self-test` exercises the healthy
control plus timeout, setup, signal, and missing-test rejection cases. The
tracked test is byte-for-byte restored after each mutation and in `finally`.

The hosted terminal receipts for the two red results are recorded with the
exact run/job identity. Both exact-head hosted attempts returned the required
`both-red` result in both the normal and forced-red invocations:

| workflow attempt | hosted log timestamps | result |
| --- | --- | --- |
| 1 | 02:07:28Z and 02:11:21Z | `shrink-backlog-below-alarm-budget: red`; `remove-rearm-assertion: red` |
| 2 | 02:52:05Z and 02:56:04Z | `shrink-backlog-below-alarm-budget: red`; `remove-rearm-assertion: red` |

The receipts are in the linked `ci-g43` job logs above. Local execution also
returned `both-red`, but it is not substituted for the hosted evidence.

## Before/after wall-clock cost

The baseline workflow and `ci-g43` durations above are the before receipts.
The two after receipts below are terminal green runs at historical source head
`21427a5`; they are retained as source-head evidence, not relabelled as the
later `cd15a27` docs-only head or as the W207 repair head:

| receipt | workflow wall-clock | `ci-g43` wall-clock | result |
| --- | ---: | ---: | --- |
| main [34418417311](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34418417311) | 35 m 44 s | 8 m 04 s | green |
| G79 [34427912295 attempt 1](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295) | 41 m 50 s | 8 m 09 s | green |
| G79 [34427912295 attempt 2](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34427912295/attempts/2) | 43 m 21 s | 8 m 17 s | green |
| W207 repair head [34442088611](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34442088611), `b1602ec` | 44 m 30 s | 7 m 49 s | terminal green; 21 jobs plus aggregate verify |

The whole-workflow increase is in the existing long G30/G32/forced-red lanes;
the G43 lane itself increased by only 5–13 seconds while adding assertion
receipts and the two red-mutant proofs. The selected 10,000 ms budget is
therefore based on the measured 5,121 ms PR #158 failure and the genuine 33
obligation/SQL/alarm work, not on a CI anecdote or on changing a production
guard.

## W207 F3 — receipt provenance and process receipts

Every new W207 timing/inventory row carries the actual PR source SHA, the
separate workflow checkout SHA, workflow run ID, workflow attempt, hosted job,
and invocation. The historical rows are
not renamed: both attempts of run `34427912295` are explicitly
`21427a58534efe8af4b3553322268f84fd6cbbd6`, while run `34433781998` is
explicitly `cd15a2729ea2aa062515012ad1938266856ede2b` and is docs-only
equivalent to the source behavior at `21427a5`. An invocation is a command
inside a job; a workflow attempt is a top-level hosted execution.

The implementation lifecycle receipts are also identified without depending
on parent-host state:

| process event | accessible receipt | meaning |
| --- | --- | --- |
| W204 claim | local artifact `sdt-g79-hosted-budget-calibration-w204.md` and its recorded `intent-cli worker claim --kind issue --number 159 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write --format json` result | issue #159 was claimed before implementation |
| W204 completion | the same local artifact's recorded `intent-cli worker complete --kind issue --number 159 --repo J-Tech-Japan/sekiban-dcb-ts --outcome pr-created --pr 160 --write --format json` result | PR #160 was created before the prior completion |
| W207 review readiness | local child packet plus `intent-cli guide review --pr 160 --repo J-Tech-Japan/sekiban-dcb-ts --domain sekiban-dcb-ts --format json` | `ready:true`, `gaps:[]`, all five packet files present |
| W207 repair completion | `intent-cli worker complete --kind issue --number 159 --repo J-Tech-Japan/sekiban-dcb-ts --domain sekiban-dcb-ts --outcome pr-created --pr 160 --github-only --write --format json` returned `proceed:true`, `applied:true`, `prTargetApplied:true`; summary: issue-side completion was already recorded and PR review-publication metadata was ensured | executed after the PR body update; child-cwd warning explicitly says queue-state linked-PR sync was skipped, consistent with the no-parent-host-state boundary |

The W204 process receipts are referenced as local implementation artifacts,
not asserted to be independently verified GitHub events in this document.
The W207 repair report supplies the exact post-update completion output and
the final PR head.

## Scope and evidence boundary

Only the G43 test budget, the all-lane timing/inventory reporters, the G79
mutation runner, the conditional Vitest config repair, and this evidence are
in scope. There is no product-code change, no G43 repair, no assertion
removal, no skip/flaky annotation, no CI timeout inflation, and no change to
PR #158. W209 has complete repeated per-test receipts for every supported
Vitest invocation in the existing workflow; its proof-only commands are
explicitly inventory-only and do not receive invented body durations. The
single censored-only test and the three expected failed mutation/probe rows
are named above. Historical main and W208 receipts remain historical and are
not used as current per-test values; no duration is inferred from a file
total.

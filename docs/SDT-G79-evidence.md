# SDT-G79 hosted budget evidence

Task: `SDT-G79-HOSTED-BUDGET-CALIBRATION-W204`, with the W207 review repair
recorded below.

This document records the measurement and proof for the G43 hosted test lane,
the W207 all-lane invocation inventory, and the receipt provenance correction.
It does not change product behavior or the G43 proof boundary. The held PR
#158 and `test/g43-tag-sql.spec.ts` on that PR were not modified or rerun for
this unit.

W207 review repair scope is limited to measurement inventory, structured
mutation-result validation, receipt provenance, and this evidence. The G43
33-obligation body, SQL `LIMIT 32`, re-arm assertion, and all G43 coordination
and production sources are unchanged.

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
| Other 18 assertions in the G43 lane | 5,000 ms, Vitest inherited default | No budget is changed. Each assertion is emitted by the hosted timing report; every measured near-budget result would be named there, while comfortable results remain on the inherited default. A green anecdote is not used as the basis for the selected 10,000 ms budget. |

The G43 reporter is complete for its three-file invocation, not for every
workflow lane. W207 adds `scripts/g79-ci-inventory.mjs`, which inventories
every test/proof command declared in the existing hosted workflow and attaches
an explicit measurement status. This prevents an unmeasured lane from being
silently called comfortable.

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
| `ci-g46` | [102734555212](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555212) | 4 | partial: file/suite receipt only | retained G43 measurement 60,000 ms is source-located; this receipt exposes file/suite time, not all assertion durations |
| `ci-g41` | [102734555288](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555288) | 2 | missing | G41 normal/forced-red invocations are inventoried; no per-test duration receipt |
| `ci-local-e2e` | [102734555345](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555345) | 8 | missing | store/D1/MV/consumer/build/E2E invocations are inventoried; no per-test hosted duration receipt |
| `cosmos-emulator` | [102734555357](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555357) | 17 | missing | Cosmos/G20/G22/G26–G32 candidate invocations are inventoried; no per-test hosted duration receipt |
| `ci-coverage` | [102734555391](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102734555391) | 3 | missing | G40 coverage/negative/needs checks are inventoried; no per-test duration receipt |
| `verify` | [102742377068](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34433781998/job/102742377068) | 1 | aggregate only | required aggregate status, not a test-body budget |

The inventory command names each exact command, so the table is not a claim
that `if ... forced-red` is a second workflow attempt. It is a second
invocation row within the same job. The hosted receipt columns above are
available in the same workflow run; the new W207 command emits the exact
`commitSha`, workflow attempt, and invocation fields in the repair receipt.

### Per-test budget catalog: measured, comfortable, near, and missing

The checkable near-budget threshold is observed duration at least 50% of the
budget. The complete supported per-test receipts available to W207 show no
near-budget test. The following rows name every explicit non-default budget
candidate found in the test tree and do not turn a missing measurement into a
comfortable classification.

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

Comfortable measured tests are all 20 G43 assertions in the repeated tables,
G67 AC3, and the six-boundary repair test. No measured row reaches 50%, so the
near-budget set is empty **within the supported receipts**. The missing rows
and the 20 non-G43 workflow entries (19 missing/partial timing entries plus
the aggregate) are named explicitly; W207 makes no
unsupported claim about their margins and raises no additional timeout.

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

The whole-workflow increase is in the existing long G30/G32/forced-red lanes;
the G43 lane itself increased by only 5–13 seconds while adding assertion
receipts and the two red-mutant proofs. The selected 10,000 ms budget is
therefore based on the measured 5,121 ms PR #158 failure and the genuine 33
obligation/SQL/alarm work, not on a CI anecdote or on changing a production
guard.

## W207 F3 — receipt provenance and process receipts

Every new W207 timing/inventory row carries the actual checkout SHA, workflow
run ID, workflow attempt, hosted job, and invocation. The historical rows are
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
| W207 repair completion | the canonical worker-complete receipt will be attached after the PR update, never before it | process ordering is explicit; no premature completion is claimed |

The W204 process receipts are referenced as local implementation artifacts,
not asserted to be independently verified GitHub events in this document.
The W207 repair report supplies the exact post-update completion output and
the final PR head.

## Scope and missing evidence

Only the G43 test budget, G43-lane timing/inventory reporters, G79 mutation
runner, and this evidence are in scope. There is no product-code change, no
G43 repair, no assertion removal, no skip/flaky annotation, no CI timeout
inflation, and no change to PR #158. G43 has complete repeated per-test
receipts; G67 and the six-boundary repair have named comfortable receipts.
The all-lane inventory explicitly records the other lanes' missing per-test
measurements; their margins are not inferred. Historical main receipts did
not expose assertion-level durations, so the before comparison is honestly
limited to their file/suite and workflow clocks; no per-test main value is
inferred.

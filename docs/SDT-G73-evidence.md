# SDT-G73 CI determinism evidence

Task: `SDT-G73-CI-DETERMINISM-W193`
Issue: [#149](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/149)
Base: `origin/main` at `aca03b74d5677cffc42df105668235801f5a2580`
Branch: `claude/sdt-g73-ci-determinism-w193`

## Contract and process

The issue body was read as the standalone contract before code work. The child
preflight classified issue #149 as `ready-to-implement` under
`execution-unit:SDT-G73`, and the canonical worker claim was applied with
`intent-cli worker claim --kind issue --number 149 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write`.
The branch was cut from the fetched `origin/main` SHA above. No product
behavior, package version, release, credential, skip, retry, or real guard was
changed.

## Recorded main-red baselines

| Run | Main head | Red lane and characterization |
| --- | --- | --- |
| [34328164091](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34328164091) | `3769ccd1c0c853f52c88e684734f3a920fdf0686` | `ci-foundation` failed `test/g67-safe-lane.spec.ts` AC3 at the inherited 5,000 ms timeout and `test/g69-ordering.spec.ts` held-tag append returned 503 `partition_registration_unavailable`; 794 passed, 2 failed, 1 skipped. |
| [34302437259](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259) | `82501b8c649b674a3c36db30122363fe2e9c1cca` | `ci-g21-g25` failed the G54 empty-V1-array comparison: expected `duration: PT0S`, received `duration: PT0.001S`. |
| [34287701420](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287701420) | `4e5da819260027b3c4c96eb75b31cf939c0b5131` | `ci-foundation` repeated the G54 timing comparison failure; `ci-g64` independently failed its pre-existing dry-run publish gate because `@sekiban/dcb-core@0.1.0` was already published. Neither release gate nor credentials was changed. |
| [34287217805](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287217805) | `7353b987e94a999d60ec6b41b1df2387efb11ac5` | Newly catalogued `ci-g45` failed (job [102265463495](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287217805/job/102265463495)); its retained [check annotation](https://github.com/J-Tech-Japan/sekiban-dcb-ts/runs/102265463495) classifies the failure as the hosted runner losing communication with GitHub/server. It is not a G45 assertion failure, and the annotation does not establish CPU, memory, networking, or another specific cause. |

These are the four completed main runs used by the issue's AC5 denominator:
`4/4` failed. The `ci-g45` record is distinct from the already-repaired
published-version collision in `ci-g64` above; the latter is retained only as
the historical release-gate signature from run `34287701420` and is excluded
from G73 failure attribution and the after-rate.

The hosted green comparison used for calibration was
[34348593490](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34348593490)
at head `487f5c...`: G67 AC3 took 3,907 ms, commit AC7 864 ms, the exact-key
tag G5 case 928 ms, the repair checkpoint 1,546 ms, and the repair six-boundary
case (already explicitly 15,000 ms) 3,499 ms. The tag file total was 2,663 ms.
The G67 measurement is the `ci-g44` job
[102473543093](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34348593490/job/102473543093),
not a local wall-clock estimate.

## Characterization and changes

### G43 AC6: coordination, not retiming

The failure was a test-fixture interleaving: a nested `SELF.fetch` append could
start an independent response-after automatic drain, so the newly inserted
obligation could be acknowledged before the outer alarm resumed its source
scan. This is not a production ordering defect. The fixture now invokes the
exact private append-handler seam inside the same Tag actor with automatic
drain scoped off for that nested operation, then performs a same-Durable-
Object SQL read that asserts the nested event row is durable before the outer
scan continues. No production source changed, and no sleep, retry, or weaker
expectation was added.

The new temporary production mutant changes the source scanner from
`status <> 'acknowledged'` to `status = 'acknowledged'`. Its focused AC6 oracle
turns red, proving that removing the finding cannot pass. The existing five G43
fact mutants remain red as well.

### Inherited five-second budgets

| Case | Before | Measurement | Change and reason |
| --- | --- | --- | --- |
| `test/g67-safe-lane.spec.ts` AC3 | inherited 5,000 ms; red at 5,000 ms in run 34328164091 | supported Vitest JSON test-body clock in W201: healthy 1,103 ms; 32 nominal rounds, each a bounded batch of 16 complete real G69 admission-diagnostic deliveries, 3,314 ms; 69.09 ms measured added work per nominal round; calibrated 194-round representative red at 14,809 ms with `Test timed out in 10000ms` | explicit 10,000 ms. The selected test-body margin is 8,897 ms. The representative repeats the actual `D1EventStore.recordDelivery` G69 admission-diagnostic path, with rounds selected from the measured calibration and a 1.5 safety factor; no timer or synthetic delay is used. Process startup/teardown is reported separately and is not subtracted from the body margin. The G67 functional assertions and existing mutants remain unchanged. |
| `test/commit.spec.ts` AC7 | inherited 5,000 ms | hosted green 864 ms; 10 repeats passed at the tighter 2,000 ms probe | explicit 3,000 ms to remain tight while covering the loaded local observation just over 2 seconds. |
| `test/tag.spec.ts` exact-key G5 | inherited 5,000 ms | hosted green 928 ms; 10 repeats passed at the tighter 2,000 ms probe | explicit 3,000 ms. |
| `test/tag.spec.ts` concurrent G5 | inherited 5,000 ms | included in the hosted tag file total of 2,663 ms; 10 repeats passed at the tighter 2,000 ms probe | explicit 3,000 ms. |
| `test/repair.spec.ts` bounded scan checkpoint | inherited 5,000 ms; reached the default under a loaded local full-suite run | hosted green 1,546 ms; 10 repeats passed | explicit 10,000 ms. This is the unidentified inherited case from the issue; the existing six-boundary test at line 410 already has its explicit 15,000 ms budget and was not retuned. |

The local full-suite run is not claimed green: the default parallel worker run
also saturated unrelated G43 backlog, repair six-boundary, and the newly
explicit cases. The focused and loaded affected-suite runs are green, and the
hosted measurements above are the calibration source. No global timeout or
parallelism setting was changed to hide that local stress behavior.

### Driver-timing equality search

The repository search covered `test/**/*.ts`, `test/**/*.tsx`, and
`test/**/*.mjs` equality assertions and manually classified timing-related
numeric contract checks in tests and scripts.

Changed:

- `test/g54-envelope-boundary.spec.ts`: empty-V1 response compares semantic
  `writtenEvents`/`tagWriteResults` and only checks that public `duration` is a
  string.
- `test/g45-head-facts.spec.ts`: serialized success response compares every
  semantic field after removing only driver-reported `duration`, then checks
  that the public field remains present as a string.

Already safe or intentionally retained:

- `test/g22-bootstrap-d1.spec.ts` uses `semanticD1Result` and its explicit
  `D1_DRIVER_ONLY_META_KEYS` set for `duration`, routing, timing, and retry
  metadata.
- `test/g13-wire-invariance.spec.ts` compares the public key list, not a
  driver value; `duration` remains required by the wire-shape contract.
- `test/g54-interop.spec.ts` and `test/g54-accepted-positive.spec.ts` use
  fixed mocked transport responses, not equality against a live driver value.
- `test/g69-ordering.spec.ts` records diagnostic duration/cost evidence and
  checks non-negativity or bounded cost, not equality to a driver timestamp.
- G30/G65 elapsed and duration checks are deliberate product budget or trace
  contract guards, not Miniflare metadata equality.

`npm run test:g73:guard` runs a source scanner over 101 test files and 2,055
equality assertions, plus one explicit G22 snapshot-normalization check. It
reported zero violations. Its self-test is red for literal and shorthand
`duration` deep equality, serialized `"duration": ...` equality, and a raw
G22 snapshot-style comparison of a D1 result; it allows a public key-list
assertion. The production G22 source remains normalized through
`semanticD1Result`.

## G69 characterization boundary

The held-tag append in the hosted baseline returned:

```text
503 {"error":"Source partition registration is unavailable; retry the commit.","code":"partition_registration_unavailable","retryable":true}
```

This is a real SDT-G69 product-path failure signature, not a five-second test
timeout and not evidence for a retry or budget calibration. The unchanged
isolated `test/g69-ordering.spec.ts` run passed 8/8 locally and emitted the
expected `G69_ORDERING_PROOF`; the discrepancy is reported for the G69 owner.
No G69 test, product path, retry, or timeout was changed in this PR.

### Separate G69 ordering-timeout receipt

The G69 timeout receipt requested for separate design disposition is not
recoverable from the retained evidence. The available main annotation for run
`34328164091`, `ci-foundation` job
[102390192006](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34328164091/job/102390192006),
identifies the G67 timeout at `test/g67-safe-lane.spec.ts:731`, while its
separate G69 annotation identifies the 503 at
`test/g69-ordering.spec.ts:134` / test line 253. No retained annotation,
downloadable job log, or local W193/W198 artifact supplies a G69
`Test timed out ...` receipt, so there is no G69 timeout run/job/attempt
identity or exact timeout signature to assert here.

The evidence is therefore deliberately split:

| Path | Recoverable identity/signature | Disposition |
| --- | --- | --- |
| G67 safe-lane timeout | Run `34328164091`, `ci-foundation` job `102390192006`, `test/g67-safe-lane.spec.ts:731`, `Test timed out in 5000ms` | G67 inherited-budget evidence; not a G69 timeout. |
| G69 held-tag ordering refusal | Run `34328164091`, `ci-foundation` job `102390192006`, `test/g69-ordering.spec.ts:134` / line 253, 503 `partition_registration_unavailable` | Possible/real G69 product defect; unchanged and not calibrated away. |
| G69 ordering timeout | No recoverable receipt, identity, or exact signature in the retained records | Uncharacterized possible G69 defect pending receipt recovery; design disposition must not infer it from G67. |

This absence is an evidence-availability result, not a claim that the G69
timeout did or did not occur. No rerun was performed for W200.

## Repeat-run measurement

The affected probes were run ten times each, with no Vitest retry option:

```text
G43 AC6 finding:                 10/10 passed
G67 AC3 (10,000 ms):             10/10 passed
commit AC7:                     10/10 passed
tag G5 (both cases):            10/10 passed
repair bounded-scan checkpoint: 10/10 passed
repair six-boundary:             10/10 passed
G45 duration sibling:           10/10 passed
G54 duration sibling:           10/10 passed
```

The loaded affected-suite run after the durable barrier was 7 files, 65/65
tests passed. The complete local default-parallel `npm test` was intentionally
recorded as red under host saturation rather than relabeled green; its
failures were the unrelated G43 backlog and worker-contention timeouts, while
the hosted CI result is the terminal acceptance check.

## W193 baseline PR and terminal hosted CI

[PR #156](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/156) is open
against `main`, non-draft, and contains `Closes #149`.

- Exact W193 checkpoint head: `dc2d1c08d977183b54e3be353387f10132f3176b`.
- [CI workflow run 34359651286](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34359651286) — completed successfully; all 21 jobs, including `verify`, passed.
- [Terminal `verify` job 102509260661](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34359651286/job/102509260661) — passed.
- [SDT-G59 domain release preflight 34359651297](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34359651297) — passed.

## W195 repair evidence for review findings F1-F3

This repair keeps the G69 boundary above unchanged and does not alter product
behavior. It adds only test/guard evidence for the three review findings.

- F1: the timing guard now rejects literal and shorthand driver-field
  equality, and has a targeted normalization-boundary check against the actual
  typed G22 source (`diagnosticAttempts` must pass through
  `semanticD1Result`). The guard self-test mutates that source from
  `.all<Record<string, unknown>>()` to the raw driver result and goes red; the
  live scan reports 101 files, 2,055 equality assertions, one G22
  normalization check, and zero violations.
- F2: the live G54 empty response now requires the exact top-level keys
  `duration`, `tagWriteResults`, and `writtenEvents`, with exact semantic
  values after removing only the variable duration. The focused shape proof
  reports `extra-response-field: red` and `duration-variation: green`.
- F3: the selected 10,000 ms G67 AC3 bound is tied to hosted job
  `102473543093` (3,907 ms healthy, 6,093 ms margin) and a supported same-clock
  local body proof. W201 remeasured the repaired runner at 1,103 ms healthy
  (8,897 ms margin), then 3,314 ms for exactly 32 nominal rounds, each a
  bounded batch of 16 complete real G69 admission-diagnostic deliveries. The
  measured added work is 69.09 ms per nominal round; the 1.5-factor
  representative was 194 nominal rounds and red at 14,809 ms with the exact
  Vitest timeout. This current receipt supersedes the earlier W195/W198 local
  round-count receipt, whose mutation shape was the source of the W201 hosted
  coordination failure. The proof records healthy margin and a
  regression-detection margin without process-clock subtraction or unsupported
  delay. The repair checkpoint is separately recorded as 10/10; the existing
  six-boundary case remains 15,000 ms and is not conflated with that checkpoint.

The repair is pushed to PR #156 at the exact head reported in the companion
W195 artifact.

## W200 evidence-publication repair

This W200 update publishes the already-verified W198 receipts in the durable PR
evidence. It changes documentation only; it does not rerun the suite or alter
tests, timing budgets, CI configuration, production behavior, or G69.

### Exact-head full-workflow after-rate

The comparable hosted workflow is GitHub Actions `CI`, event `pull_request`,
run `34381584698`, at exact head
`665f4f338c21b5c9e214b0b2a1747c7aff3c4a94`. Each attempt completed the full
20-lane matrix and aggregate `verify` job (21 jobs total), with distinct
attempt/job identities:

| Attempt | Workflow attempt | Head | Foundation job | Verify job | Terminal result |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | [attempt 1](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/attempts/1) | `665f4f338c21b5c9e214b0b2a1747c7aff3c4a94` | [102567491149](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102567491149) | [102582312727](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102582312727) | `completed / success` |
| 2 | [attempt 2](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/attempts/2) | `665f4f338c21b5c9e214b0b2a1747c7aff3c4a94` | [102582590488](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102582590488) | [102597325670](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102597325670) | `completed / success` |
| 3 | [attempt 3](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/attempts/3) | `665f4f338c21b5c9e214b0b2a1747c7aff3c4a94` | [102597550776](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102597550776) | [102611723729](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102611723729) | `completed / success` |
| 4 | [attempt 4](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/attempts/4) | `665f4f338c21b5c9e214b0b2a1747c7aff3c4a94` | [102612101762](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102612101762) | [102625936350](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584698/job/102625936350) | `completed / success` |

The repaired-head after-rate is **0 failed / 4 completed** (`0%` failed,
`100%` terminal-success), compared with the four completed main baseline
runs above at **4 failed / 4 completed** (`100%` failed). No after-run had a
remaining failure signature. These are four attempts of one immutable head,
not four independent commits; the sample is reported as observed evidence and
does not claim that every future flake is impossible.

The separate [release preflight run
34381584694](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584694)
at this head also completed successfully (job
[102567489838](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34381584694/job/102567489838)); it is not part of the G73 AC5 numerator or denominator.

### Characterization corrections

- **`ci-g45`** — Run [34287217805](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287217805), job [102265463495](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287217805/job/102265463495), has a retained [check annotation](https://github.com/J-Tech-Japan/sekiban-dcb-ts/runs/102265463495) saying that the hosted runner lost communication with GitHub/server. This is explicitly **not** a G45 assertion failure. The annotation is insufficient to identify CPU, memory, network, or any other particular underlying cause, so none is claimed.
- **`ci-g64`** — Run [34287701420](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287701420) retains the already-repaired historical publish collision: `@sekiban/dcb-core@0.1.0` was already published during the dry-run gate. It is baseline history only, excluded from G73 attribution and the after-rate.
- **G69 ordering timeout versus G67 timeout** — The separate G69 timeout receipt remains unavailable in the retained records: no run/job/attempt identity, downloadable annotation/log, or exact `Test timed out ...` signature is available for a G69 timeout. The recoverable G69 record is the distinct run `34328164091` / `ci-foundation` job `102390192006` 503 `partition_registration_unavailable` at `test/g69-ordering.spec.ts:134` / line 253. The recoverable five-second timeout in that job is G67 at `test/g67-safe-lane.spec.ts:731`, not G69. The G69 timeout is therefore an uncharacterized possible real defect pending receipt recovery; it is not inferred from G67 and was not rerun or changed here.

The PR remains at the exact W200 docs-repair head after the bounded commit and
push reported with this artifact.

## W201 G67 calibration coordination repair

W201 repairs the exact hosted failure at PR #156 head
`b6496291056c02344afaab46c65b04f06448a7e2`. The change is limited to the
test-only G73 mutation runner and this evidence document. It does not change
`test/g67-safe-lane.spec.ts`, production code, the 10,000 ms AC3 budget, G69
behavior, retries, or CI configuration.

### First-error provenance and characterization

The first error is preserved in hosted [CI run
34400106755](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34400106755),
`ci-foundation` [job
102629592598](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34400106755/job/102629592598),
attempt 1, at the exact W200 head above. The job's ordinary `npm test` step
completed first with 95 files passed and 1 skipped, 806 tests passed and 1
skipped. The G73 timing scanner then reported zero violations and its G22
raw-snapshot mutant self-test was red. The next command was
`npm run test:g73:guard`; its first failure was:

```text
Error: G67 AC3 32-round G69 calibration unexpectedly failed:
```

The child Vitest output ended in real G67 DO/D1 telemetry without a Vitest
test summary, and the runner exited 1 while requiring the calibration oracle
to be healthy. This is a runner-coordination failure, not a recoverable G69
`partition_registration_unavailable` receipt and not a production assertion
failure.

The cause was the W198 mutation anchor. It inserted a nominal 32-round block
at a point inside each of AC3's ten paced commits. Each round replayed the two
queued messages, so the advertised 32-round calibration could perform up to
`32 × 10 × 2 = 640` real `recordDelivery` calls, plus the base G67 work, while
waiting on each asynchronous G69 diagnostic. Hosted execution did not finish
that multiplied child run under the existing coordination, producing the
misleading `calibration unexpectedly failed` result despite the ordinary suite
being green.

### Bounded runner repair

The W201 runner now asserts a unique mutation anchor immediately after the
base `await Promise.all(waiters)` and before the public safe read. It scopes
the calibration block to `index === 1`, so the nominal 32-round observation
runs exactly once rather than once per paced commit. Each nominal round uses
16 unique, valid G32 envelopes on an isolated calibration service/tag. Every
envelope is admitted through the real `D1EventStore.recordDelivery` Queue path,
and its `waitUntil` G69 diagnostic promise is awaited before the next complete
operation. Thus the calibration measures 32 rounds / 512 complete real
admission-diagnostic operations without duplicate replay or synthetic delay.
The representative uses the same bounded batch and selects its round count
from the supported Vitest JSON test-body duration. No process clock, timer,
unsupported delay, timeout widening, or production behavior is involved.

Focused local proof at this repair state:

```text
node --check scripts/g73-g67-budget-mutation-runner.mjs       passed
node scripts/g73-g67-budget-mutation-runner.mjs --self-test   passed
{"budgetMs":10000,"calibrationRounds":32,"g69OperationsPerRound":16,"safetyFactor":1.5,"selfTest":"vitest-body-clock-and-g69-path-valid"}
{"budgetMs":10000,"healthyBodyMs":1103,"healthyMarginMs":8897,"calibrationRounds":32,"g69OperationsPerRound":16,"calibrationBodyMs":3314,"measuredAddedWorkPerRoundMs":69.09,"representativeRounds":194,"regressionBodyMs":14809,"regressionOverBudgetMs":4809,"timeoutMessage":"Test timed out in 10000ms","processOverheadMs":{"healthy":3730,"calibration":3474,"regression":3760},"attempts":[{"rounds":194,"processStatus":1,"bodyStatus":"failed","bodyDurationMs":14809,"processElapsedMs":18569}],"result":"healthy-green-g69-path-timeout-red"}
```

The final exact-head hosted CI receipt and terminal job identity will be
appended with the W201 report after the repair push; the historical G69
ordering-timeout and 503 boundary above remains unchanged.

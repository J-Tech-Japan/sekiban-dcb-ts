# SDT-G81 SafeWindow ceiling evidence

## Scope and provenance

This document records the SDT-G81 test-only repair for issue [#164](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/164). The dedicated branch is `claude/sdt-g81-safe-window-w230`; W236 rebased it onto `origin/main` at `5bc9d2226bded255875f04c5f6b6bd032463033d`. The intended change set is limited to `test/read.spec.ts`, this evidence document, and the G81-only semantic mutation runner `scripts/g81-safe-window-mutation-runner.mjs`. The earlier `193cfa44563d08ffadef146c4eca769098044be1` base and W230 head are retained below as historical provenance, not as the current base.

The prior red receipt is [workflow 34509483454](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454), [ci-g46 job 102979771313](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454/job/102979771313), on PR #163 source `4cefc3f5`. Its failure was `test/read.spec.ts:338`, `expected 500, received 200`, after a 1,316 ms test run. This is retained as the historical trigger, not as evidence for this branch's final result.

## AC1 — bounded diagnosis and durable lag capture

The existing Postgres implementation persists `estimate_ms` and `observed_at` in `serialized_dcb_lag_estimates`; `currentLagBound` decays an epoch observation by elapsed milliseconds ([`PostgresEventStore.ts:601-620`](../packages/dcb-runtime/src/store/PostgresEventStore.ts)). The read worker samples `Date.now()` before checking the dynamic lag bound ([`SerializedReadWorker.ts:205-225`](../packages/dcb-runtime/src/read/SerializedReadWorker.ts)), and the published ceiling predicate is strict `>` ([`safeWindow.ts:20-22`](../packages/dcb-runtime/src/safeWindow.ts)). Therefore a 121,000 ms observation becomes eligible after roughly one second of wall-clock decay when the seed and reader do not share a clock.

Before the repair, a temporary test-only diagnostic around the unmodified test shape captured the durable row and public read bounds:

```json
{"g81Ac1Diagnostic":true,"seedTime":1789077864744,"persistedLag":{"estimateMs":121000,"observedAt":1789077864744},"beforeRead":1789077864840,"afterRead":1789077864869,"lagAtBeforeRead":120904,"lagAtAfterRead":120875,"responseStatus":500}
```

The diagnostic deliberately failed after printing the capture and was fully reverted; it is not a product or committed-test change. It is a local mechanism demonstration: under that temporary pinned setup the public path returned 500 while the read-time lag remained above the 120,000 ms ceiling. It does not prove the historical hosted failure's exact clock values; those values were not captured by the historical receipt. The historical hosted 200 remains the trigger classified as a timing race, not a product-defect finding, but this local diagnostic is not retroactive hosted evidence. If the repaired test ever observes a lag above the ceiling with a 200 response, its assertion message includes the persisted row and read-time bounds and the result must be treated as a product-defect stop condition.

The committed AC1 test pins one epoch clock (`G81_PINNED_CLOCK = 1_800_000_000_000`) before both the real `recordDelivery` seed and the public `SELF.fetch`. It reads back the persisted estimate and records `beforeRead`, `afterRead`, both derived lag bounds, and the response status in the assertion message. This is mechanism/contract evidence for the repaired test path, not a claim that it captured the historical hosted clock values.

## AC2 — the public reader observes the pinned clock

`[G81] AC2 proves the public reader evaluates the SafeWindow ceiling at the pinned clock` changes the same `Date.now` spy after the first public read. Results from the focused local run:

| public read clock | persisted estimate | derived lag | response |
| ---: | ---: | ---: | ---: |
| `1,800,000,000,000` | 121,000 ms at the same epoch | 121,000 ms | 500 `internal_error` |
| `1,800,000,002,000` | same durable row | 119,000 ms | 200 `{ exists: false, lastSortableUniqueId: "" }` |

The test asserts both `beforeRead` and `afterRead` equal each pinned value. The changed public decision proves the reader evaluates the supplied clock during the public request; pinning only setup would not produce the 500-to-200 transition.

## AC3 — exact public boundaries

`[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader` uses separate service/tag identities, one shared pinned epoch clock, real Postgres delivery, and the public `tag-latest-sortable` request:

| durable estimate at pinned observation | public result | proof |
| ---: | ---: | --- |
| exactly 120,000 ms | 200 | empty latest-sortable body `{ exists: false, lastSortableUniqueId: "" }` |
| exactly 120,001 ms | 500 | JSON `internal_error` |

For both rows the test asserts the durable `estimate_ms`/`observed_at` values and exact `beforeRead`/`afterRead` clock values. The strict `>` boundary is therefore exercised through the exported HTTP worker path rather than only by a helper or private predicate.

## AC4 — semantic mutation proof

`scripts/g81-safe-window-mutation-runner.mjs` has exactly two source-shape targets and invokes Vitest with only `test/read.spec.ts` plus the exact name pattern for **one selected AC3 test**:

1. Remove the `safeWindowCeilingExceeded` branch in `SerializedReadWorker.ts`; expected 500 becomes 200.
2. Change the strict `>` predicate in `safeWindow.ts` to `>=`; expected 200 becomes 500 at the equality boundary.

The runner consumes the structured Vitest JSON report rather than classifying combined output. It requires a normal status-1/no-signal process, exactly one reported `test/read.spec.ts` file, exactly one executed assertion, the exact named AC3 oracle, and its public HTTP-status assertion marker (`G81 AC3 boundary capture`). It then parses the mutation-specific expected/received status pair and the JSON boundary capture: the omission mutation must show `120001` ms with expected 500 and received 200; the `>=` mutation must show `120000` ms with expected 200 and received 500. Other failed tests, setup/import/database failures, timeout, signal, missing or skipped target, unrelated assertion/output, malformed capture, wrong boundary, or wrong pair are rejected. Each mutation has a healthy control, rebuilds the runtime bundle after mutation, restores the source in `finally`, and rebuilds again. The self-test validates both unique anchors, the one-test G81-only oracle, semantic records, and all of those failure-class controls.

Recorded local results:

```json
{"mutations":[{"id":"remove-ceiling-check","boundaryLagMs":120001,"expectedStatus":500,"receivedStatus":200},{"id":"ceiling-greater-or-equal","boundaryLagMs":120000,"expectedStatus":200,"receivedStatus":500}],"oracle":"[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader","publicAssertion":"G81 AC3 boundary capture","testFile":"test/read.spec.ts","selfTest":"anchors-g81-only-oracle-structured-red-and-failure-class-controls","rejectedCases":["green target","missing report","signal termination","setup/import failure","database failure","timeout","missing oracle","skipped target","unrelated assertion","unrelated output","wrong boundary","wrong expected/received pair"]}
```

Fresh structured red records from source head `fcdb316111e850eaeff48a3fc2a1d8e20ea80bb7` follow. The source head is the code head on which both temporary mutations were executed; the later evidence-only commit does not alter the runner or test source.

```json
{"id":"remove-ceiling-check","sourceFile":"packages/dcb-runtime/src/read/SerializedReadWorker.ts","result":"semantic-mutant-red","sourceHead":"fcdb316111e850eaeff48a3fc2a1d8e20ea80bb7","selectedTest":"[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader","publicAssertion":"G81 AC3 boundary capture","boundaryLagMs":120001,"expectedStatus":500,"receivedStatus":200,"process":{"status":1,"signal":null,"error":null},"structuredReport":{"success":false,"failedTests":1,"totalTests":9},"failedAssertion":{"statusPair":{"receivedStatus":200,"expectedStatus":500,"format":"vitest-inline"},"capture":{"lagMs":120001,"responseStatus":200,"persistedLag":{"estimateMs":120001,"observedAt":1800000000000}},"failureExcerpt":"AssertionError: G81 AC3 boundary capture {\"lagMs\":120001,\"seedTime\":1800000000000,\"persistedLag\":{\"estimateMs\":120001,\"observedAt\":1800000000000},\"beforeRead\":1800000000000,\"afterRead\":1800000000000,\"responseStatus\":200}: expected 200 to be 500 // Object.is equality"}}
{"id":"ceiling-greater-or-equal","sourceFile":"packages/dcb-runtime/src/safeWindow.ts","result":"semantic-mutant-red","sourceHead":"fcdb316111e850eaeff48a3fc2a1d8e20ea80bb7","selectedTest":"[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader","publicAssertion":"G81 AC3 boundary capture","boundaryLagMs":120000,"expectedStatus":200,"receivedStatus":500,"process":{"status":1,"signal":null,"error":null},"structuredReport":{"success":false,"failedTests":1,"totalTests":9},"failedAssertion":{"statusPair":{"receivedStatus":500,"expectedStatus":200,"format":"vitest-inline"},"capture":{"lagMs":120000,"responseStatus":500,"persistedLag":{"estimateMs":120000,"observedAt":1800000000000}},"failureExcerpt":"AssertionError: G81 AC3 boundary capture {\"lagMs\":120000,\"seedTime\":1800000000000,\"persistedLag\":{\"estimateMs\":120000,\"observedAt\":1800000000000},\"beforeRead\":1800000000000,\"afterRead\":1800000000000,\"responseStatus\":500}: expected 500 to be 200 // Object.is equality"}}
```

The product source was restored after the proof; `git diff --name-only -- packages/dcb-runtime/src` is empty.

### Delay demonstration

The required non-committed diagnostic inserted a real `setTimeout(1_600)` between seeding and the public read. This is another local mechanism demonstration, not proof of the historical hosted values. It produced:

```json
{"delayMs":1600,"repaired":{"seedTime":1800000000000,"status":500,"beforeRead":1800000000000,"afterRead":1800000000000},"unmodified":{"seedTime":1789078725382,"status":200,"beforeRead":1789078727034,"afterRead":1789078727061}}
```

The temporary diagnostic file was deleted after the run. The committed test itself has no sleep, retry, timeout adjustment, flaky annotation, or changed production behavior.

## AC5 — scope and unchanged behavior

Focused local verification completed on the repaired worktree:

```text
npx vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/read.spec.ts --testNamePattern 'G81'
Test Files  1 passed (1)
Tests       3 passed | 6 skipped (9)

npm run lint
exit 0

npm run typecheck
exit 0

git diff --check
exit 0
```

`npm run typecheck` rebuilt all packages successfully. No runtime source, package metadata, workflow, global timeout, retry, skip, or unrelated test lane was changed. The existing `npm test`/ci-g46 read suite remains the caller; the focused local verification selects all three G81 tests, while the mutation runner intentionally selects only the one AC3 test by exact name pattern.

## Historical W230 hosted receipts

The following receipts belong to the earlier W230 implementation and are
retained as historical evidence, not as W238 execution:

- [workflow 34537083905](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905), `headSha=f4f519c7b7245ae83f3878bece119fbdd8ee4423`, status `completed`, conclusion `success`.
- The 21 terminal jobs were all successful, including [ci-foundation job 103071105862](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105862), [ci-g43 job 103071106033](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106033), [ci-g46 job 103071106251](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106251), and [verify job 103081721745](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103081721745).
- Other terminal lane receipts: [ci-g21-g25](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105892), [ci-g26-g27](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106023), [ci-g28](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105664), [ci-g29](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105964), [ci-g30-core](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106115), [ci-g30-forced-red](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105876), [ci-g31](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106043), [ci-g32-parity](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105935), [ci-g38](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106159), [ci-g41](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106121), [ci-g42](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105884), [ci-g44](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106081), [ci-g45](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106088), [ci-g64](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105932), [ci-coverage](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105905), [ci-local-e2e](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106057), and [cosmos-emulator](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106110).

The hosted logs explicitly prove the G81 observations ran at the exact workflow head:

| Hosted invocation | G81 evidence | terminal result |
| --- | --- | --- |
| `ci-foundation` → `npm test` | `test/read.spec.ts` 9 tests passed; AC1 213 ms, AC2 334 ms, AC3 416 ms; whole foundation suite 95 files / 808 tests passed, 1 skipped | success; [job log](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071105862) |
| `ci-g46` → `test:g46` | `test/read.spec.ts` 9 tests passed; AC1 222 ms, AC2 400 ms, AC3 441 ms; lane 4 files / 33 tests passed | success; [job log](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34537083905/job/103071106251) |

Thus AC1's public observations (the three named G81 tests) actually ran on hosted infrastructure in both the foundation `npm test` invocation and the G46 read suite. The run's workflow-level `headSha` is the source identity used here. The G79 timing reporter also emits the PR workflow's `GITHUB_SHA` field (`b156a40b23610776673ffe99178a3430fa0e41d8`) in its timing records; that auxiliary merge/ref identity is not substituted for the exact branch `headSha` above.

The historical red workflow above remains linked separately from the successful
W230 receipt.

## Historical W236 rebase receipts

W236 rebased the branch onto main `5bc9d2226bded255875f04c5f6b6bd032463033d`
without a conflict and pushed exact source head
`803595cdfb2b0986c876e55873caddc19a457949`. Its [CI workflow
34555853353](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34555853353)
and [release preflight
34556132337](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34556132337)
both completed successfully at that head. W236's hosted G81 AC1/AC2/AC3
observations were 258/275/366 ms in `ci-foundation`'s broad `npm test`; its
mutation proof was local. The complete W236 handoff is retained at
`sdt-g81-pr165-rebase-ci-w236.md`. These receipts remain historical after the
W238 validator repair.

## Lifecycle

The W230 issue claim and immediate PR-created completion remain historical. For
W238, the PR was claimed through the canonical GitHub-only PR repair flow before
editing, and completion will be recorded as `repair-pushed` after the bounded
validator/evidence push. Fresh W238 PR/CI/preflight identities and the final
head are recorded below once terminal.

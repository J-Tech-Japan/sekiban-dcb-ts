# SDT-G81 SafeWindow ceiling evidence

## Scope and provenance

This document records the SDT-G81 test-only repair for issue [#164](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/164). The dedicated branch is `claude/sdt-g81-safe-window-w230`, based on `origin/main` at `193cfa44563d08ffadef146c4eca769098044be1`. The intended change set is limited to `test/read.spec.ts`, this evidence document, and the G81-only semantic mutation runner `scripts/g81-safe-window-mutation-runner.mjs`.

The prior red receipt is [workflow 34509483454](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454), [ci-g46 job 102979771313](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34509483454/job/102979771313), on PR #163 source `4cefc3f5`. Its failure was `test/read.spec.ts:338`, `expected 500, received 200`, after a 1,316 ms test run. This is retained as the historical trigger, not as evidence for this branch's final result.

## AC1 — bounded diagnosis and durable lag capture

The existing Postgres implementation persists `estimate_ms` and `observed_at` in `serialized_dcb_lag_estimates`; `currentLagBound` decays an epoch observation by elapsed milliseconds ([`PostgresEventStore.ts:601-620`](../packages/dcb-runtime/src/store/PostgresEventStore.ts)). The read worker samples `Date.now()` before checking the dynamic lag bound ([`SerializedReadWorker.ts:205-225`](../packages/dcb-runtime/src/read/SerializedReadWorker.ts)), and the published ceiling predicate is strict `>` ([`safeWindow.ts:20-22`](../packages/dcb-runtime/src/safeWindow.ts)). Therefore a 121,000 ms observation becomes eligible after roughly one second of wall-clock decay when the seed and reader do not share a clock.

Before the repair, a temporary test-only diagnostic around the unmodified test shape captured the durable row and public read bounds:

```json
{"g81Ac1Diagnostic":true,"seedTime":1789077864744,"persistedLag":{"estimateMs":121000,"observedAt":1789077864744},"beforeRead":1789077864840,"afterRead":1789077864869,"lagAtBeforeRead":120904,"lagAtAfterRead":120875,"responseStatus":500}
```

The diagnostic deliberately failed after printing the capture and was fully reverted; it is not a product or committed-test change. It shows the local public path correctly returned 500 while the read-time lag remained above the 120,000 ms ceiling. The hosted 200 in the historical receipt is consequently classified as the timing race, not as evidence of a product defect. If the repaired test ever observes a lag above the ceiling with a 200 response, its assertion message includes the persisted row and read-time bounds and the result must be treated as a product-defect stop condition.

The committed AC1 test pins one epoch clock (`G81_PINNED_CLOCK = 1_800_000_000_000`) before both the real `recordDelivery` seed and the public `SELF.fetch`. It reads back the persisted estimate and records `beforeRead`, `afterRead`, both derived lag bounds, and the response status in the assertion message.

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

`scripts/g81-safe-window-mutation-runner.mjs` has exactly two source-shape targets and invokes Vitest with only `test/read.spec.ts` plus the exact AC3 name pattern:

1. Remove the `safeWindowCeilingExceeded` branch in `SerializedReadWorker.ts`; expected 500 becomes 200.
2. Change the strict `>` predicate in `safeWindow.ts` to `>=`; expected 200 becomes 500 at the equality boundary.

The runner retains the process status, signal, spawn error, and output. It requires a normal status-1 Vitest assertion failure containing the exact named oracle and the expected/received pair; timeout, setup/import, signal, missing-oracle, and unrelated failures are rejected. Each mutation has a healthy control, rebuilds the runtime bundle after mutation, restores the source in `finally`, and rebuilds again. The self-test validates both unique anchors and the G81-only oracle.

Recorded local results:

```json
{"mutations":[{"id":"remove-ceiling-check","sourceFile":"packages/dcb-runtime/src/read/SerializedReadWorker.ts"},{"id":"ceiling-greater-or-equal","sourceFile":"packages/dcb-runtime/src/safeWindow.ts"}],"oracle":"[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader","testFile":"test/read.spec.ts","selfTest":"anchors-and-g81-only-oracle"}
```

```json
{"result":"all-g81-safe-window-mutants-red","oracle":"[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader","rows":[{"id":"remove-ceiling-check","status":1,"signal":null,"result":"semantic-mutant-red"},{"id":"ceiling-greater-or-equal","status":1,"signal":null,"result":"semantic-mutant-red"}]}
```

The product source was restored after the proof; `git diff --name-only -- packages/dcb-runtime/src` is empty.

### Delay demonstration

The required non-committed diagnostic inserted a real `setTimeout(1_600)` between seeding and the public read. It produced:

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

`npm run typecheck` rebuilt all packages successfully. No runtime source, package metadata, workflow, global timeout, retry, skip, or unrelated test lane was changed. The existing `npm test`/ci-g46 read suite remains the caller; the new mutation runner filters exclusively to the three G81 tests by exact name pattern.

## Hosted receipts

The dedicated PR and exact-head hosted receipts will be appended here after the branch is pushed. Until then, no hosted green result is claimed for this implementation. The historical red workflow above remains linked separately from the final exact-head result.

## Lifecycle

The issue claim was applied before implementation with the GitHub-only worker protocol for issue #164. The ready-for-review PR is created from the dedicated branch against `main`; the canonical `worker complete --outcome pr-created` receipt is emitted immediately after PR creation, before hosted CI polling. Exact commit, PR, claim, completion, and terminal workflow/job URLs are recorded in this section when available.

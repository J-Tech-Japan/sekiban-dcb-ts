# SDT-G86 evidence

Evidence record for issue #179 (SDT-G86): `SekibanExecutor.execute` honours
`totalBudgetMs`, `signal` and its service scope, both executors classify every
failure through one code-to-kind table, and nothing a command handler returns
is dropped.

## Scope and evidence boundary

- Branch `claude/sdt-g86-implementation`, cut from `origin/main`
  `681da42f3b114f8e5f46422f3eff3e01feb3ccff`, which already contains SDT-G88
  (#178). The implementation commit is
  `ae6a36d2201385234a94a1138491c814dc4f11e4`; this document is a separate
  commit on top of it.
- Changed: `packages/dcb-client/src/classification.ts` (new, internal),
  `packages/dcb-client/src/control.ts` (new, internal),
  `packages/dcb-client/src/executor.ts`, `packages/dcb-client/src/index.ts`,
  `packages/dcb-domain/src/session.ts`,
  `scripts/g78-error-classification-guard.mjs`, one row in
  `docs/SDT-G78-evidence.md`, and new tests in existing spec files.
- Deliberately unchanged (out of scope): `ClaimLedgerExecutor`'s retry
  validation, cap and backoff, its core `CommandDefinition` commit path, its
  decision `value` and `CommitHttpResult.headers` (SDT-G87); the other legacy
  bridge fields (SDT-G89); error message wording of existing codes; the sample
  worker's kind-to-HTTP mapping; wire protocol; `packages/dcb-runtime`;
  `scripts/g71-read-contract-mutation-runner.mjs` (see "G71 mutation-runner
  anchors").
- No CI lane, G40 step inventory or timeout changed. New tests live in the
  existing spec files `test/g78-error-classification.spec.ts`,
  `test/g57-executor.spec.ts`, `test/g71-read-contract.spec.ts`,
  `test/g13-client.spec.ts` and `test/dcb-domain.spec.ts`;
  `npm run test:g40:tiers` exits 0.
- The AC11 process items that belong to the orchestrator (intent-cli worker
  claim, pushing, PR creation, `worker complete --outcome pr-created`,
  exact-head CI) are not performed by this implementation seat and are not
  claimed here.

## AC1: one classification table

`packages/dcb-client/src/classification.ts` exports `FAILURE_KINDS` (code to
kind), `failureKindForCode`, `classifyFailure` and `commitReplyError`.
`ClaimLedgerExecutor` (`classifyError` and `classifyCommitResponse` in
`index.ts`) and `SekibanExecutor` (`failureResult` and `commitAttemptResult`
in `executor.ts`) both classify through it. `classifyFailure` keeps a
`ClientError` whose code has a kind as it is; anything else crosses
`sanitizeTransportError`, so an unknown or foreign code fails closed to
`transport`. `partial` is copied only for kind `partial`.

The kinds allowed per SDT-G78 class:

| SDT-G78 class | allowed kinds |
| --- | --- |
| caller-abort | `timeout` |
| deadline/unknown | `timeout`, `unavailable` |
| definite-refusal | `invalid`, `rejected`, `conflict`, `partial` |
| malformed/unknown | `transport` |

`node scripts/g78-error-classification-guard.mjs` derives the finite code set
from source as before, imports `packages/dcb-client/dist/classification.js`
and fails when a derived code has no kind or a kind outside its class. Its
actual `kinds` output (exit 0):

```
"aborted":"timeout","assert_empty_failed":"invalid","authority_unavailable":"transport",
"claim_not_in_candidate_tags":"invalid","command_rejected":"rejected","consistency_conflict":"conflict",
"credential.rejected":"rejected","domain_authoring_error":"invalid","duplicate_consistency_entry":"invalid",
"http_error":"transport","incoherent_read_snapshot":"transport","invalid_command_input":"invalid",
"invalid_command_result":"transport","invalid_consistency":"invalid","invalid_execute_options":"invalid",
"invalid_query_request":"invalid","invalid_query_response":"transport","invalid_read_snapshot":"transport",
"partial_write":"partial","projection_unavailable":"unavailable","read_unavailable":"unavailable",
"scope.mismatch":"invalid","timeout":"timeout","transport":"transport","unknown_outcome":"timeout",
"unsupported_capability":"invalid","unsupported_consistency_mode":"invalid"
```

`node scripts/g78-error-classification-guard.mjs --self-test` (exit 0) prints
`"selfTest": ["unclassified-code-red", "injected-code-without-kind-red",
"deleted-kind-red", "kind-outside-class-red"]`. The facade-only refusals that
never pass through a `ClientError` (`executor.snapshot_missing`,
`invalid_command_input`, `scope.mismatch`) stay `invalid`.

New code `domain_authoring_error` (definite-refusal, kind `invalid`) has its
row in `docs/SDT-G78-evidence.md` and in the guard's `classifications`.

## AC2: commit outcomes, one rule for both executors

`commitReplyError` in the shared module: a non-2xx commit reply whose body and
reply carry no `code` is `unknown_outcome` at status 500 or above and
`http_error` below (409 is `consistency_conflict` through the sanitizer's own
fallback); a reply with a code is sanitized, so an unknown code becomes
`transport`. Reads still use `sanitizeTransportError(..., { fallbackCode:
"http_error" })` directly and keep its fallback (a 503 read without a code is
`unavailable` / `projection_unavailable`, asserted in the AC3 test below). A
2xx reply keeps the facade's richer committed result.

Test: `test/g78-error-classification.spec.ts:303` "SDT-G86 AC2: classifies
identical commit replies identically through both executors". It runs the same
commit adapter through `ClaimLedgerExecutor.execute` and
`SekibanExecutor.execute`, prints the table below, then asserts
`{ kind, code, status }` per row for both executors (and the partial facts for
the two partial rows). Facade-only fields and `attempts` are outside the
comparison. The caller-action column is derived from the expected kind.

Actual output after the change (`npx vitest run --config vitest.config.ts
test/g78-error-classification.spec.ts -t "SDT-G86 AC2" --reporter=verbose`,
exit 0):

```
stdout | test/g78-error-classification.spec.ts > SDT-G78 public error classification > SDT-G86 AC2: classifies identical commit replies identically through both executors
SDT-G86 AC2 commit outcome table
| adapter reply | expected kind / code / status | ClaimLedgerExecutor | SekibanExecutor | caller action |
| --- | --- | --- | --- | --- |
| 2xx | committed / - / 200 | committed / - / 200 | committed / - / 200 | committed |
| 409 no code | conflict / consistency_conflict / 409 | conflict / consistency_conflict / 409 | conflict / consistency_conflict / 409 | reread and recompute |
| 409 consistency_conflict | conflict / consistency_conflict / 409 | conflict / consistency_conflict / 409 | conflict / consistency_conflict / 409 | reread and recompute |
| 400 no code | transport / http_error / 400 | transport / http_error / 400 | transport / http_error / 400 | reconcile, never blindly reissue |
| 400 command_rejected | rejected / command_rejected / 400 | rejected / command_rejected / 400 | rejected / command_rejected / 400 | fix the request |
| 422 unknown code | transport / transport / 422 | transport / transport / 422 | transport / transport / 422 | reconcile, never blindly reissue |
| 500 no code | timeout / unknown_outcome / 500 | timeout / unknown_outcome / 500 | timeout / unknown_outcome / 500 | reconcile, never blindly reissue |
| 500 internal_error | transport / transport / 500 | transport / transport / 500 | transport / transport / 500 | reconcile, never blindly reissue |
| 500 partial_write (validated partial body) | partial / partial_write / 500 | partial / partial_write / 500 | partial / partial_write / 500 | reconcile, never blindly reissue |
| 503 no code | timeout / unknown_outcome / 503 | timeout / unknown_outcome / 503 | timeout / unknown_outcome / 503 | reconcile, never blindly reissue |
| 503 projection_unavailable | unavailable / projection_unavailable / 503 | unavailable / projection_unavailable / 503 | unavailable / projection_unavailable / 503 | reconcile, never blindly reissue |
| 504 no code | timeout / unknown_outcome / 504 | timeout / unknown_outcome / 504 | timeout / unknown_outcome / 504 | reconcile, never blindly reissue |
| thrown TypeError | transport / transport / - | transport / transport / - | transport / transport / - | reconcile, never blindly reissue |
| thrown AbortError | timeout / aborted / - | timeout / aborted / - | timeout / aborted / - | reconcile, never blindly reissue |
| thrown foreign error carrying partial_write | partial / partial_write / - | partial / partial_write / - | partial / partial_write / - | reconcile, never blindly reissue |
```

The same test run against the unmodified base source (written first,
red-before-green) printed these observed values and failed at its first
mismatch (`AssertionError: 400 no code via SekibanExecutor: expected { kind:
'rejected', …(2) } to deeply equal { kind: 'transport', …(2) }`). Every row
whose result changed, before (base `681da42`) and after:

| adapter reply | executor | before | after |
| --- | --- | --- | --- |
| 500 no code | ClaimLedgerExecutor | transport / http_error / 500 | timeout / unknown_outcome / 500 |
| 503 no code | ClaimLedgerExecutor | unavailable / projection_unavailable / 503 | timeout / unknown_outcome / 503 |
| 400 no code | SekibanExecutor | rejected / http_error / 400 | transport / http_error / 400 |
| 422 unknown code | SekibanExecutor | rejected / transport / 422 | transport / transport / 422 |
| 500 no code | SekibanExecutor | timeout / unknown_outcome / - | timeout / unknown_outcome / 500 |
| 500 internal_error | SekibanExecutor | timeout / unknown_outcome / - | transport / transport / 500 |
| 500 partial_write (validated partial body) | SekibanExecutor | timeout / unknown_outcome / - | partial / partial_write / 500 |
| 503 no code | SekibanExecutor | timeout / unknown_outcome / - | timeout / unknown_outcome / 503 |
| 503 projection_unavailable | SekibanExecutor | timeout / unknown_outcome / - | unavailable / projection_unavailable / 503 |
| 504 no code | SekibanExecutor | timeout / unknown_outcome / - | timeout / unknown_outcome / 504 |
| thrown TypeError | SekibanExecutor | invalid / transport / - | transport / transport / - |
| thrown foreign error carrying partial_write | SekibanExecutor | invalid / partial_write / - | partial / partial_write / - |

After dispatch, `transport`, `timeout` and `unavailable` are unknown outcomes
to reconcile, never to reissue blindly.

**Caller action for `invalid_command_result`** (kind `transport`, its
malformed/unknown class): it is raised before dispatch when a command does not
return a decision; inspect the command, nothing was sent.

### Other classification changes, before and after

These come from a Node probe that bundles the base sources
(`git show origin/main:...`) and the branch sources with esbuild and runs the
same calls against each (`node probe-before.mjs`, `node probe-after.mjs`, both
exit 0; the probe lives outside the repository).

| call | before (base) | after |
| --- | --- | --- |
| ClaimLedgerExecutor: command throws `ClientError` `invalid_read_snapshot` | invalid / invalid_read_snapshot | transport / invalid_read_snapshot |
| ClaimLedgerExecutor: command throws `ClientError` `incoherent_read_snapshot` | invalid / incoherent_read_snapshot | transport / incoherent_read_snapshot |
| ClaimLedgerExecutor: command throws `ClientError` `invalid_query_response` | invalid / invalid_query_response | transport / invalid_query_response |
| ClaimLedgerExecutor: command throws `ClientError` `invalid_command_result` | invalid / invalid_command_result | transport / invalid_command_result |
| ClaimLedgerExecutor: command throws `ClientError` `authority_unavailable` | invalid / authority_unavailable | transport / authority_unavailable |
| ClaimLedgerExecutor: command throws `ClientError` with an unclassified code `g86_custom_code` | invalid / g86_custom_code / "probe g86_custom_code" | transport / transport / "Transport request failed" |
| ClaimLedgerExecutor: command returns a non-object decision | invalid / invalid_command_result | transport / invalid_command_result |
| ClaimLedgerExecutor: ledger read of a malformed tag-state | invalid / invalid_read_snapshot | transport / invalid_read_snapshot |
| SekibanExecutor: handler throws a plain `Error` | transport / (no code) / raw message "probe raw handler message" | transport / transport / "Transport request failed" |
| SekibanExecutor: handler reads an undeclared tag | invalid / transport / "Transport request failed" | invalid / domain_authoring_error / "UNDECLARED_DYNAMIC_READ" |
| SekibanExecutor: authority 503 without a code during execute | invalid / projection_unavailable / 503 | unavailable / projection_unavailable / 503 |

`ClaimLedgerExecutor` also no longer infers kind `partial` from a `partial`
field on an error whose code is not `partial_write`; the kind follows the code
alone (the sanitizer only ever keeps `partial` for `partial_write`).

## AC3: failures before the commit

Test: `test/g71-read-contract.spec.ts:432` "SDT-G86 AC3: classifies a failure
raised while execute reads through the shared table", next to the capability
case. Read errors inside `execute` now reach the outer catch unmodified and are
classified by `failureResult`. Asserted `{ kind, code, status }` and adapter
calls per case:

| case | result | adapter calls |
| --- | --- | --- |
| read-through without `readTagLatestSortable` | invalid / unsupported_capability / 501 | none |
| authority 503 without a code | unavailable / projection_unavailable / 503 | authority |
| authority reply carrying `authority_unavailable` | transport / authority_unavailable / 503 | authority |
| thrown `TypeError` during the authority read | transport / transport | authority |
| tag-state 503 without a code | unavailable / projection_unavailable / 503 | authority, tag-state |
| supplied SnapshotReader raising `ClientError` `read_unavailable` | unavailable / read_unavailable / 503 | none |
| supplied SnapshotReader throwing a plain `Error` | transport / transport | none |
| snapshot-only on an uncovered claim | invalid / executor.snapshot_missing | no commit |
| invalid command input | invalid / invalid_command_input | no commit |
| handler throws `DomainAuthoringError("G86_HANDLER_AUTHORING")` | invalid / domain_authoring_error, `error: "G86_HANDLER_AUTHORING"` | no commit |
| handler reads an undeclared tag (domain layer) | invalid / domain_authoring_error, `error: "UNDECLARED_DYNAMIC_READ"` | no commit |

A `DomainAuthoringError` is recognised by `instanceof` or, for a separate
package copy in a Worker bundle, by its string `code` together with one of the
dcb-domain error names (`DomainAuthoringError`, `DomainRegistrationError`,
`BoundaryParseError`, `SessionStateError`, `UndeclaredReadError`,
`IncoherentSnapshotError`).

## AC4: total budget

`packages/dcb-client/src/control.ts`: `totalBudgetMsProblem` accepts only
`undefined` or a finite number from 0 to 2147483647. `awaitControlled` now
takes the operation as a function and checks the signal and the deadline
before starting it, then awaits it under both. Both executors use it.

- Facade: `totalBudgetMs` and `maxConflictRetries` are validated before any
  call; the deadline is `Date.now() + totalBudgetMs`, taken once; an abort or
  an already-expired deadline returns before any call; every adapter call
  `execute` makes (authority, tag-state, commit) and every supplied
  SnapshotReader call (`read`, `exists`, `head`) runs under that deadline.
- ClaimLedgerExecutor: the per-call `totalBudgetMs` and the constructor
  `totalBudgetMs` are each validated at `execute`; an invalid value resolves
  to invalid / invalid_execute_options with `attempts: 0` before the command
  runs.

Receipts (all tests exit 0 in `npm run test:g57` and the focused runs):

| test | asserted |
| --- | --- |
| `test/g57-executor.spec.ts:444` "AC4: refuses an invalid totalBudgetMs as invalid_execute_options before any adapter call" | NaN, +Infinity, -Infinity, -1, 2^31 in snapshot-only and read-through → invalid / invalid_execute_options / attempts 0, zero reads and commits; 1000 and 2147483647 commit |
| `test/g57-executor.spec.ts:485` "AC4: bounds the whole execute, supplied reader calls included, and never retries an expired commit" | 0 → timeout / timeout, zero calls; 20 ms budget, 80 ms authority read → timeout / timeout, one authority call, no tag-state, no commit (checked 70 ms later); 20 ms budget, 80 ms supplied `SnapshotReader.read` in snapshot-only → timeout / timeout, no commit; 20 ms budget, 80 ms pending commit with `maxConflictRetries: 3` → timeout / timeout and exactly one commit; option omitted with a 30 ms commit → committed |
| `test/g13-client.spec.ts:235` "SDT-G86 AC4: refuses an invalid totalBudgetMs before any command or commit call" | ClaimLedgerExecutor per-call and constructor NaN, +Infinity, -Infinity, -1, 2^31 → invalid / invalid_execute_options / attempts 0, zero command executions and commits; 1000 and 2147483647 commit |
| existing `test/g13-client.spec.ts:215` (base `:214`) "turns a hanging commit into a bounded timeout without a second attempt" and `test/g78-error-classification.spec.ts` "AC3/AC4: preserves caller abort, deadline, definite refusal and unknown outcome distinctly" (zero budget) | unchanged, pass |

**An expiry while a commit is pending is an unknown outcome to reconcile**:
the commit may have been written. It is reported as timeout / timeout, it is
not retried inside `execute` (the rejection leaves `executeCommand` through
its catch), and the caller must reconcile, never reissue blindly. The same
holds for an abort while a commit is pending (timeout / aborted).

Longest controlled adapter delay in the tests: 80 ms.

## AC5: cancellation

The facade passes `ExecuteCommandOptions.signal` to every transport call
`execute` makes, reads included (`readStateWith` and `existsWith` receive it),
and `awaitControlled` checks it before each call and each commit attempt.
Supplied `SnapshotReader` calls have no signal parameter and are covered by
the abort await only. The public `readState`/`exists`/`query`/`listQuery`
keep their own `ReadOptions.signal` and run uncontrolled, as before.

Test: `test/g57-executor.spec.ts:573` "AC5: forwards the caller signal to every
adapter call and checks it before each call":

- aborted before `execute` → timeout / aborted, zero reads and commits;
- aborted while the authority read is pending → timeout / aborted; the
  authority adapter received the same `AbortSignal` instance
  (`toBe(controller.signal)`); counts 60 ms later are authority 1, tag-state 0,
  commit 0 (the abandoned read's continuation is refused before the tag-state
  call);
- aborted while the tag-state read is pending → timeout / aborted; both
  adapters received the same instance; commit 0;
- aborted while a commit is pending (`maxConflictRetries: 3`, the reply would
  be a 409) → timeout / aborted, exactly one commit, the commit adapter
  received the same instance.

## AC6: service scope on reads

`readState`, `exists`, `query` and `listQuery` call `assertScope()` first and
reject with `new ClientError("scope.mismatch", "Executor service scope does not
match its transport")` before any adapter call. Test:
`test/g57-executor.spec.ts:657` "AC6: refuses a service-scope mismatch on every
read method before calling the adapter": all four reject with a `ClientError`
`scope.mismatch`, `execute` still returns invalid / scope.mismatch, zero adapter
calls; with matching ids, executor-only, transport-only and no ids the four
reads resolve and call the adapter as before. The existing
`test/g57-executor.spec.ts:380` (base `:379`) scope test is unchanged and
passes.

## AC7: nothing a handler returns is dropped

- `ExecuteCommitted.value?` is declared on the shared type; a committed facade
  result carries `value` when the done decision has one, and has no `value` key
  otherwise. **`ClaimLedgerExecutor` does not fill `value` until SDT-G87.**
- New facade-only `ExecutorRejected = ExecuteRejected & { rejectKind?; details? }`.
  A handler rejection carries `rejectKind`, and `details` when present; a
  commit-side rejection has neither.
- `code` keeps SDT-G57's rule: a string `details`, else the V1 reject code.

Test: `test/g57-executor.spec.ts:706` "AC7: keeps the done value, rejectKind and
details a handler returns without changing the code rule":
`done({ echoed, count })` → `value` kept; `done()` → no `value` key;
`reject("conflict", "already there")` → exactly
`{ kind: "rejected", attempts: 1, error, code: "consistency_conflict", rejectKind: "conflict" }`
(never kind conflict); `reject("conflict", "reservation already exists",
"reservation_exists")` → `code: "reservation_exists"`, `details:
"reservation_exists"`; object details → `code: "validation_error"`,
`rejectKind: "validation"`, `details` kept; a 400 `command_rejected` commit
reply → rejected / command_rejected / 400 without `rejectKind` or `details`.

## AC8: exhausted conflict after SDT-G88

The commit closure's conversion of the final conflict into `rejected`, and the
`status === "rejected"` branch that turned it back into a conflict, are
removed. The closure now returns `consistency-conflict` for every conflict
reply and `executeCommand`'s `status: "conflict"` is mapped by the single
`conflictResult` branch. `test/g57-executor.spec.ts` "AC2: exposes typed
conflict details without retrying when retries are disabled" is byte-identical
to the base (it moved from `:362` to `:363` only because one import line,
`reject,`, was added above it) and passes; "SDT-G88 AC4: keeps an exhausted
conflict typed for maxConflictRetries 1 and 2" (`:402`) is unchanged and
passes. Mutant M7 below removes the status mapping and that test turns red.

## AC9: retry and restore inputs

- Facade `maxConflictRetries` is validated before the snapshot-only override;
  default 1, no cap. Test `test/g57-executor.spec.ts:773`: NaN, +Infinity, -1,
  0.5 in snapshot-only and read-through → invalid / invalid_execute_options /
  attempts 0, zero reads and commits. `maxConflictRetries: 2` at three commit
  attempts stays pinned by the unchanged `test/g57-executor.spec.ts:402`.
- A commit reply that is not a `CommitHttpResult` is unknown. Same test:
  `undefined`, `null`, `"committed"`, `{ writtenEvents: [] }`, `{ ok: true }` →
  timeout / unknown_outcome with exactly one commit (before: committed, probe
  row "non-HTTP commit reply").
- `Session.loadSnapshot` parses supplied snapshot state (array snapshots reach
  it through the facade's reader; `SnapshotReader.read` results; the
  `adaptRuntimeCommand` `state` record) through `projector.validateState` when
  the projector has one, and throws `DomainAuthoringError`
  `SNAPSHOT_STATE_INVALID` otherwise. The parsed value replaces the supplied
  state, as SDT-G88's `deserializeState` already does. Tests:
  `test/dcb-domain.spec.ts:1156` (five invalid states throw
  `SNAPSHOT_STATE_INVALID` with zero handler and commit calls; a valid state
  reaches the handler parsed, an unknown key dropped by the schema; a projector
  without a state schema is not constrained) and `test/dcb-domain.spec.ts:1210`
  (`adaptRuntimeCommand` with a schema-invalid `snapshots` reader and a
  schema-invalid `state` record both reject with `SNAPSHOT_STATE_INVALID`
  and zero commits; a valid `state` commits).
- Facade: `test/g57-executor.spec.ts:814`: an invalid array snapshot and an
  invalid `SnapshotReader` (snapshot-only and read-through) → invalid /
  domain_authoring_error, `error: "SNAPSHOT_STATE_INVALID"`, no commit; a valid
  array snapshot commits. `readState` on a decoded payload that violates the
  room state schema rejects with `ClientError` `invalid_read_snapshot`; inside
  `execute` the same read is transport / invalid_read_snapshot with no commit;
  a valid payload resolves with the parsed state. The check is structural
  (`validateState` is not on `ProjectorLike`); the G71 `ProjectorLike`
  fixtures without it are unaffected.

## Public type changes against the published 0.1.0

Compared with `git show dcb-v0.1.0:packages/dcb-client/src/{index,executor}.ts`.

| Package | Change | Additive / breaking vs 0.1.0 | Reason |
| --- | --- | --- | --- |
| `@sekiban/dcb-client` | `ExecuteCommitted.value?: JsonValue` (dcb-domain's readonly `JsonValue`, which also accepts dcb-core values) | Additive (optional) | AC7: a done decision's value was dropped; filled by the facade now, by `ClaimLedgerExecutor` in SDT-G87 |
| `@sekiban/dcb-client` | New `ExecutorRejected = ExecuteRejected & { rejectKind?: RejectKind; details?: unknown }`; `ExecuteCommandResult` uses it in place of `ExecuteRejected` | Additive (every `ExecuteRejected` value is an `ExecutorRejected`; the shared `ExecuteRejected` is unchanged) | AC7 and the design decision: facade-only, like `ExecutorConflict` |
| `@sekiban/dcb-client` | New result code `domain_authoring_error` (kind `invalid`, definite-refusal) | Additive code; behaviour change for handler/domain authoring errors (previously invalid / transport) | AC3 |
| `@sekiban/dcb-client` | `ClaimLedgerExecutor` refuses an invalid `totalBudgetMs` (per call or constructor) with invalid / invalid_execute_options; `ClaimLedgerExecutorOptions` and `ExecuteOptions` types unchanged | Behaviour change (previously a dispatched commit was reported as timeout for NaN, Infinity, 2^31) | AC4 |
| `@sekiban/dcb-client` | `SekibanExecutor.execute` refuses an invalid `totalBudgetMs` with invalid / invalid_execute_options; `ExecuteCommandOptions` type unchanged | Behaviour change (the option was never read) | AC4 |
| `@sekiban/dcb-client` | `readState`, `exists`, `query`, `listQuery` reject `scope.mismatch` on a mismatched scope | Behaviour change (previously called the mismatched adapter); no type change | AC6 |
| `@sekiban/dcb-domain` | `Session.loadSnapshot` throws `DomainAuthoringError` code `SNAPSHOT_STATE_INVALID` for supplied state that fails `projector.validateState` | Additive code; behaviour change (previously accepted) | AC9, R29-7 |
| `@sekiban/dcb-client` (internal) | New modules `classification.ts` and `control.ts`; `awaitControlled` moved there from `index.ts` and takes a function; `commitDecision` and `commitErrorFrom` removed from `executor.ts`; `snapshotReaderFrom` takes internal read functions and a runner | Internal only: none of these was exported from the package root, and the package `exports` map exposes only `.` | AC1, AC4, AC5 |

## Changed existing assertions and checks

No existing assertion in any test file changed; every test file only gained
imports, fixtures and new tests (`test/dcb-domain.spec.ts` only gained a new
`describe` block at its end). The non-assertion edits to existing content:

| Location | Before | After | AC |
| --- | --- | --- | --- |
| `test/g57-executor.spec.ts:20` | import list without `reject` | adds `reject,` (existing tests shift down one line; `:362` → `:363`) | AC7 |
| `test/g71-read-contract.spec.ts:1-34` | `import { tagFamily, type ProjectorLike, type Tag } from "@sekiban/dcb-domain"` | also imports `z`, `ClientError`, `command`, `done`, `DomainAuthoringError`, `event`, `projector as defineProjector`, `read`, `stateUnion`, `SnapshotReader` | AC3 |
| `test/g78-error-classification.spec.ts:1-12`, `test/g13-client.spec.ts:7` | existing imports | additional imports only (`z`, dcb-domain authoring helpers; `type ClientCommandContext`) | AC2, AC4 |
| `scripts/g78-error-classification-guard.mjs` `classifications` | no `domain_authoring_error` entry | entry `domain_authoring_error: definite-refusal` | AC1, AC3 |
| `scripts/g78-error-classification-guard.mjs` normal run | source-derived rows and evidence rows only | also imports `dist/classification.js` and checks every derived code's kind against its class; output gains `kinds` | AC1 |
| `scripts/g78-error-classification-guard.mjs` `--self-test` | one case, `result.selfTest = "unclassified-code-red"` | the same unclassified source-code case plus injected code without kind, deleted kind, kind outside class; `result.selfTest` is an array of the four `*-red` labels (no script reads that value) | AC1 |
| `docs/SDT-G78-evidence.md` classification table | no `domain_authoring_error` row | row `domain_authoring_error` / definite-refusal | AC3 |

## G71 mutation-runner anchors

None needed retargeting. The executor restructuring kept every exact-string
anchor of `scripts/g71-read-contract-mutation-runner.mjs` byte-identical and
unique (the controlled runner is passed as a trailing argument to `readCall`,
after the anchored lines); only their line numbers moved:

| mutant | anchor | base line | branch line |
| --- | --- | --- | --- |
| `authority-failure-as-absence` | `() => transport.readTagLatestSortable!({ tag }, signal),` | `executor.ts:204` | `executor.ts:225` |
| `mismatched-observation-heads` | `if (compareSortableUniqueId(response.lastSortedUniqueId, authority.lastSortableUniqueId) < 0) {` | `:617` | `:697` |
| `existing-empty-object-erased` | `const empty = isRecord(decoded) && decoded.status === "empty";` | `:626` | `:706` |
| `sentinel-only-existence` | `exists: true,` | `:632` | `:712` |
| `list-consistency-dropped` | `() => transport.listQuery(withConsistency, readOptions.signal),` | `:659` | `:752` |

`git diff origin/main -- scripts/g71-read-contract-mutation-runner.mjs` is
empty. `npm run test:g71` (exit 0) ran the runner's self-test and all eight
mutants: `all-g71-behavioral-product-mutants-red` with every row
`behavioral-product-mutant-red`.

## Mutants (red before green)

Each mutant was applied as an exact, once-only replacement, the named command
was run (with `npm run build:packages` first when the guard or a built package
is involved), the output saved, the file restored with `git checkout`, and the
same command re-run. Every mutant exited 1; every restored run exited 0 and
`git status --short` was empty afterwards. Output below is trimmed to the
failing test and its assertion.

**M1: restore the invalid-on-transport catch (AC1, AC2).** The facade's outer
catch again maps every coded error other than timeout/aborted to `invalid`.
`npx vitest run --config vitest.config.ts test/g78-error-classification.spec.ts test/g71-read-contract.spec.ts -t "SDT-G86 AC"` → exit 1:

```
     × SDT-G86 AC2: classifies identical commit replies identically through both executors 12ms
     × SDT-G86 AC3: classifies a failure raised while execute reads through the shared table 4ms
      Tests  2 failed | 20 skipped (22)
AssertionError: authority 503 without a code: expected { kind: 'invalid', …(2) } to deeply equal { kind: 'unavailable', …(2) }
-   "kind": "unavailable",
+   "kind": "invalid",
AssertionError: 400 no code via SekibanExecutor: expected { kind: 'invalid', …(2) } to deeply equal { kind: 'transport', …(2) }
-   "kind": "transport",
+   "kind": "invalid",
```

**M2: delete one code's kind (AC1).** `authority_unavailable: "transport",`
removed from `classification.ts`; rebuilt.
`node scripts/g78-error-classification-guard.mjs` → exit 1:

```
Error: G78 error-classification guard: source code authority_unavailable has no result kind in the shared classification module
```

**M3: inject an unclassified code (AC1).** `commitAttemptResult` throws
`new ClientError("unrecognised_commit_reply", ...)`; rebuilt.
`node scripts/g78-error-classification-guard.mjs` → exit 1:

```
Error: G78 error-classification guard: source code unrecognised_commit_reply has no classification row
```

**M4a: remove the facade budget validation (AC4).**
`npx vitest run --config vitest.config.ts test/g57-executor.spec.ts -t "AC4: refuses an invalid totalBudgetMs"` → exit 1; a dispatched commit reported as timeout:

```
     × AC4: refuses an invalid totalBudgetMs as invalid_execute_options before any adapter call 10ms
AssertionError: snapshot-only totalBudgetMs=NaN: expected { …(2) } to match object { …(2) }
-     "commits": 0,
+     "commits": 1,
-     "attempts": 0,
-     "code": "invalid_execute_options",
-     "kind": "invalid",
+     "attempts": 1,
+     "code": "timeout",
+     "kind": "timeout",
```

**M4b: remove the ClaimLedgerExecutor budget validation (AC4).**
`npx vitest run --config vitest.config.ts test/g13-client.spec.ts -t "SDT-G86 AC4"` → exit 1:

```
     × SDT-G86 AC4: refuses an invalid totalBudgetMs before any command or commit call 5ms
AssertionError: per-call totalBudgetMs=NaN: expected { …(2) } to match object { …(2) }
-     "commits": 0,
-     "executions": 0,
+     "commits": 1,
+     "executions": 1,
-     "attempts": 0,
-     "code": "invalid_execute_options",
-     "kind": "invalid",
+     "attempts": 1,
+     "code": "timeout",
+     "kind": "timeout",
```

**M5: ignore the budget (AC4).** The facade deadline is always `undefined`.
`npx vitest run --config vitest.config.ts test/g57-executor.spec.ts -t "AC4: bounds the whole execute"` → exit 1:

```
     × AC4: bounds the whole execute, supplied reader calls included, and never retries an expired commit 10ms
AssertionError: expected { …(2) } to match object { …(2) }
-     "code": "timeout",
-     "kind": "timeout",
+     "kind": "committed",
-     "commits": 0,
-     "reads": 0,
+     "commits": 1,
+     "reads": 1,
```

**M6: stop forwarding the signal to reads (AC5).** The execute reads get
`undefined` instead of the signal; the controlled await still aborts, so only
the signal-identity assertion catches it.
`npx vitest run --config vitest.config.ts test/g57-executor.spec.ts -t "AC5: forwards the caller signal"` → exit 1:

```
     × AC5: forwards the caller signal to every adapter call and checks it before each call 71ms
AssertionError: authority authority signal: expected undefined to be AbortSignal{} // Object.is equality
 ❯ test/g57-executor.spec.ts:626:69
```

**M7: remove the status conflict mapping (AC8).**
`npx vitest run --config vitest.config.ts test/g57-executor.spec.ts -t "AC2: exposes typed conflict details without retrying when retries are disabled"` → exit 1:

```
     × AC2: exposes typed conflict details without retrying when retries are disabled 11ms
AssertionError: expected { kind: 'timeout', attempts: 1, …(3) } to match object { kind: 'conflict', …(1) }
-   "kind": "conflict",
+   "kind": "timeout",
 ❯ test/g57-executor.spec.ts:374:20
```

**M8: skip supplied-snapshot validation (AC9).** `Session.loadSnapshot` uses
the supplied snapshot as read; rebuilt.
`npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts test/g57-executor.spec.ts -t "AC9: (validates SnapshotReader state|adaptRuntimeCommand refuses|validates supplied snapshot state)"` → exit 1:

```
     × AC9: validates supplied snapshot state and decoded tag-state against the projector state schema 6ms
     × AC9: validates SnapshotReader state through the projector state schema before the handler and commit 4ms
     × AC9: adaptRuntimeCommand refuses a schema-invalid supplied snapshot 2ms
      Tests  3 failed | 43 skipped (46)
AssertionError: {"kind":"unknown"}: expected undefined to be an instance of DomainAuthoringError
AssertionError: promise resolved "{ kind: 'committed', …(2) }" instead of rejecting
AssertionError: expected { Object (kind, attempts, ...) } to match object { kind: 'invalid', …(2) }
-   "code": "domain_authoring_error",
-   "error": "SNAPSHOT_STATE_INVALID",
-   "kind": "invalid",
+   "code": "transport",
+   "error": "Transport request failed",
+   "kind": "transport",
```

The new tests were also written before the implementation and run against the
base source: the G78 parity test failed (above); in `test/g57-executor.spec.ts`
the seven new tests failed and the seven existing ones passed (`Tests 7 failed
| 7 passed (14)`); in `test/dcb-domain.spec.ts`, `test/g13-client.spec.ts` and
`test/g71-read-contract.spec.ts` the four new tests failed and the rest passed
(`Tests 4 failed | 55 passed (59)`).

## Decisions taken where the issue left a choice

- `error` of `domain_authoring_error` is exactly the authoring code (for
  example `"SNAPSHOT_STATE_INVALID"`), not the authoring message.
- A `ClientError` whose code has no kind is sanitized before classification,
  so it becomes transport / transport (fail closed) in both executors.
- Supplied snapshot state and decoded tag-state are replaced by the schema's
  parsed value (parse boundary), matching SDT-G88's `deserializeState`.
- The facade recognises only `CommitHttpResult` commit replies; any other reply
  is unknown.
- An invalid `totalBudgetMs` or `maxConflictRetries`, an abort before `execute`
  and an already-expired deadline return `attempts: 0` (nothing was attempted);
  a failure raised in a later attempt reports that attempt's number.
- The facade's schema failure on `readState` is `invalid_read_snapshot` with no
  `cause`, so payload-derived schema details do not travel with the error.
- `ClaimLedgerExecutor` validates the constructor `totalBudgetMs` at `execute`
  (the constructor does not throw), and also when a valid per-call value would
  override it.

## Verification

Run on the branch head after the implementation commit (Node v24.18.0).

| command | exit | result |
| --- | --- | --- |
| `npm run build:packages` | 0 | all workspaces built |
| `npm run test:g57` | 0 | `Tests 14 passed (14)`; G57 path guard self-test and run pass |
| `npm run test:g71` | 0 | `Tests 17 passed (17)`; runner self-test; all eight G71 mutants red |
| `npm run test:g78` | 0 | `Tests 10 passed (10)`; ownership, cloud-contract, classification guard (with kinds), classification and sanitization mutation-runner self-tests, packed consumer |
| `npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts test/g13-client.spec.ts test/g13-core.spec.ts test/meeting-room.spec.ts test/g31-sample.spec.ts test/g29-meeting-room.spec.ts test/g29-mapping.spec.ts` | 0 | `Tests 162 passed (162)` |
| `npx vitest run --config vitest.config.ts` over `test/g13-public-shape`, `g16-frontend`, `g16-query`, `g24-hardening`, `g30-trace`, `g31-waitfor`, `g52-commit-breakdown`, `g52-commit-snapshot`, `g52-resume-query`, `g52-trace-export`, `g53-scope-identity`, `g55-read-visibility`, `g56-assert-empty`, `g71-composition`, `query`, `g29-delivery`, `g78-cloud-contract` (specs that mention the changed kinds or codes) | 1 | `Tests 1 failed | 127 passed (128)`; the one failure is `test/query.spec.ts` "runs commit through durable projection and every V1 endpoint on Miniflare plus Docker PostgreSQL" (`expected 500 to be 200`, unhandled `Stream was cancelled` from `postgres`): Docker PostgreSQL on `127.0.0.1:54329` was not running, and that spec imports neither dcb-client nor dcb-domain |
| `npm run test:consumer` | 0 | consumer fixtures passed |
| `npm run lint` | 0 | no warnings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:g40:tiers` | 0 | coverage, mutation proof and ignored-paths checks pass |
| `node scripts/g78-error-classification-guard.mjs --self-test` | 0 | four `*-red` self-test cases |
| `node scripts/g78-error-classification-guard.mjs` | 0 | `g78-error-classification-valid` |

A full `npm test` was not run: it needs Docker PostgreSQL, which is not
available in this environment.

# SDT-G88 evidence

Evidence record for issue #177 (SDT-G88): dcb-domain command execution reports
what actually happened, and every domain authoring option it declares either
does something or leaves the surface.

## Scope and evidence boundary

- Branch `claude/sdt-g88-implementation`, cut from `origin/main`
  `a0d6add00fe940dced471fdd5ff14a389c0545df`.
- At that base, `packages/dcb-core/src/index.ts` and `packages/dcb-domain/src`
  are byte-identical to the published tag `dcb-v0.1.0`
  (`git diff --stat dcb-v0.1.0 HEAD -- packages/dcb-core/src/index.ts packages/dcb-domain/src`
  printed nothing). Every "breaking" or "additive" label below is relative to
  that published `0.1.0`; the next carrier is `0.2.0`.
- In scope, and changed: `executeCommand` outcome reporting and retry
  validation, commit-reply recognition, `CommitAttemptResult.error`; the
  minimum `SekibanExecutor` and `adaptRuntimeCommand` handling of the new
  status; `stateUnion`/`state` discriminator; projector initial and restored
  state validation; view `deliveryClass` validation and the derived doorbell
  policy; dcb-core `done` state; `cloneAndFreeze`.
- Deliberately unchanged (out of scope): the facade's commit-closure
  conversion of the final conflict (SDT-G86 removes it), `ClaimLedgerExecutor`
  and `SerializedDcbClient` (SDT-G87), the other legacy bridge fields
  (SDT-G89), wire protocol, deployment.
- No CI lane, G40 step inventory or timeout was changed. New tests live in the
  existing spec files `test/dcb-domain.spec.ts`, `test/g57-executor.spec.ts`,
  `test/g13-core.spec.ts` and `test/g29-delivery.spec.ts`.
- The AC10 process items that belong to the orchestrator (intent-cli worker
  claim, pushing, PR creation, `worker complete --outcome pr-created`, exact-head
  CI) are not performed by this implementation seat and are not claimed here.

## Public type and behaviour changes against 0.1.0

| Package | Change | Additive / breaking vs 0.1.0 | Design reason |
| --- | --- | --- | --- |
| `@sekiban/dcb-domain` | `ExecuteCommandResult.status` gains `"conflict"` (last permitted attempt ended in a consistency conflict; carries `attempts`, `now`, `decision`, last `envelope`, `log`, `session`, `error`) | Breaking for exhaustive consumers of the status union (intended compile error) | G29 mapping row and review R29-3: a typed conflict distinct from unknown; an exhausted conflict was reported as `accepted` |
| `@sekiban/dcb-domain` | `CommitAttemptResult` `consistency-conflict` variant gains `error?: unknown`; `error` on every variant is now the reply's own `error` when present, else the reply | Additive (type); behaviour change of the `error` value | The conflict variant dropped the error and the other variants held the whole reply |
| `@sekiban/dcb-domain` | `executeCommand` throws `DomainAuthoringError` code `EXECUTE_OPTIONS_INVALID` for `maxConflictRetries` that is not `undefined` or a non-negative safe integer (NaN, ±Infinity, negative, fractional, > MAX_SAFE_INTEGER), before the clock, input parse, reads, handler or commit | Breaking behaviour (previously normalised by `Math.floor`; NaN produced accepted, Infinity unbounded retries); the code itself is additive | Normalising hides a caller bug and Infinity must not mean unbounded retries (issue design notes) |
| `@sekiban/dcb-domain` | Commit replies other than `undefined`, `true`, `{ kind: "accepted" }` and the recognised conflict/unknown/rejected shapes are `unknown` (null, false, numbers, strings, `{}`, arrays, unrecognised `kind`) | Breaking behaviour (previously accepted) | R29-3: unknown means reconcile; an unrecognised reply is not proof of a commit |
| `@sekiban/dcb-domain` | `stateUnion(schema, options)` and its alias `state`: the `discriminator` option is removed | Breaking | The zod discriminated union already owns the discriminator and `parse` enforces the closed union; the option was copied to a member nothing read and a bogus value was accepted (means/15:62) |
| `@sekiban/dcb-domain` | `StateUnion.discriminator` member removed | Breaking | Same as above; `states()` keeps its own `discriminator` option because it builds the zod union |
| `@sekiban/dcb-domain` | `projector()` resolves the initial state as `initialState ?? initial ?? state.initial` (a function initial is still invoked once) | Additive (the documented `projector({ id, tag, events, state, handlers })` previously threw `PROJECTOR_INITIAL_STATE_REQUIRED`) | `docs/domain-authoring.md` documents that shape; `StateUnion.initial` was required but never read |
| `@sekiban/dcb-domain` | When `state` is given, the initial state is parsed through `state.parse` at definition and an invalid one throws `DomainAuthoringError` code `PROJECTOR_INITIAL_STATE_INVALID` (`ProjectorDefinition.initialState` holds the parsed value) | Breaking behaviour for an invalid initial state (previously accepted); the code is additive | means/15:62: illegal states cannot be constructed |
| `@sekiban/dcb-domain` | When `state` is given, `ProjectorDefinition.deserializeState` output (default or custom) is parsed through `state.parse`, so a restored state that violates the schema throws | Breaking behaviour (previously accepted) | R29-7 and means/22:15: broken persisted bytes fail closed; the runtime already maps the throw to `TagStateCacheCorruption` / `TagStateRegistryFailure` |
| `@sekiban/dcb-domain` | New exported type `ViewDeliveryClass = "immediate-preferred" \| "queued"`; `DomainViewDefinition.deliveryClass?` is typed with it (same union as before) | Additive | Names the declared delivery classes the validation and helper share |
| `@sekiban/dcb-domain` | New exported helper `deliveryPolicyFromDomain(domain: { views?: readonly DomainViewDefinition[] }): Readonly<Record<string, ViewDeliveryClass>>` (default `queued`; rejects an undeclared class or a duplicate view id with `DomainRegistrationError`) | Additive | R29-9, R30-5 and the SDT-G29 criterion: the per-view domain descriptor is the delivery authority, views default to `queued` |
| `@sekiban/dcb-domain` | `domain()` rejects a view whose `deliveryClass` is not a declared class (`DomainRegistrationError`) | Breaking behaviour (an invalid literal was accepted) | Same authority: an undeclared class cannot be a policy |
| `@sekiban/dcb-domain` | `RuntimeDomainDefinition.views` element type is `DomainViewDefinition & { readonly deliveryClass: ViewDeliveryClass }`; `toRuntimeDomain` emits each view's effective class (`queued` when absent) as a new frozen view object | Additive for readers (narrowed output); breaking only for code that constructs a `RuntimeDomainDefinition` by hand without `deliveryClass` | R29-9: `toRuntimeDomain` emits the view deliveryClass as the runtime descriptor |
| `@sekiban/dcb-domain` | `adaptRuntimeCommand` maps status `conflict` to `{ kind: "rejected", code: "consistency_conflict", events: [] }` | Breaking behaviour (an always-conflicting runtime port returned `committed`) | Exhausted conflict is a conflict, never a commit |
| `@sekiban/dcb-domain` | `cloneAndFreeze` is no longer exported | Breaking | It did not clone: it deep-froze its input in place and overflowed the stack on cyclic input; no design record names it and `README.md` did not list it in the 0.1.x surface |
| `@sekiban/dcb-domain` | `event.make` freezes a copy of the validated payload; objects under `z.any()`/`z.unknown()` stay owned (and mutable) by the caller | Behaviour change (no type change) | AC9: do not freeze objects the caller still owns |
| `@sekiban/dcb-domain` | `serializeDecisionLog` no longer freezes the log, the handler's `done` value or reject details; a cyclic value is rejected by `JSON.stringify` (`TypeError`) instead of overflowing the stack | Behaviour change (no type change) | AC9 |
| `@sekiban/dcb-domain` | `isJsonValue` / `assertJsonValue` report a cyclic value as non-JSON (`false` / `INVALID_JSON_VALUE`) instead of overflowing the stack | Behaviour fix (no type change) | AC9: cyclic input never reaches an unbounded recursive walk in `event.make` |
| `@sekiban/dcb-core` | `done(value?, state?)` becomes `done(value?)` | Breaking | means/09-domain-definition-api.md:67,73 define `ctx.done()` as committing the appended candidates with no state; `context.done` could not set it and nothing read it |
| `@sekiban/dcb-core` | `CommandDone.state` and `CommandCommitted.state` removed; `execute` builds the committed outcome explicitly as `{ kind, value, events }` | Breaking | Same; no design gives the state semantics |
| `@sekiban/dcb-core` | The `TState` type parameter is removed from `CommandContext`, `CommandCommitted`, `CommandDone`, `CommandHandlerOutcome`, `CommandOutcome`, `CommandHandler`, `CommandDefinition`, `CommandDefinitionOptions`, `defineCommand` and `done` | Breaking for code that passes that type argument explicitly (no in-repository code does) | See "AC8: the TState generic" below |
| `@sekiban/dcb-client` | `SekibanExecutor.execute` maps `EXECUTE_OPTIONS_INVALID` to `{ kind: "invalid", attempts: 0, code: "invalid_execute_options", error }` with no read or commit; new result code `invalid_execute_options` classified as definite-refusal in `docs/SDT-G78-evidence.md` | Additive code; breaking behaviour for NaN (previously `{ kind: "committed", status: 409 }`) | AC4 |
| `@sekiban/dcb-client` | `SekibanExecutor.execute` maps `executeCommand` status `conflict` to `{ kind: "conflict", attempts, status, code: "consistency_conflict", conflicts }` (shared with the retained rejected-to-conflict branch) | Additive | AC4; the commit-closure conversion stays until SDT-G86 |
| `@sekiban/dcb-runtime` (private, unpublished) | `RuntimeWorkerConfig.deliveryViews` removed | Breaking type change in a private package | Nothing read it; the doorbell policy is derived from the domain's views (AC7) |
| `@sekiban/dcb-runtime` (private, unpublished) | `RuntimeDomainLike.views` removed | Breaking type change in a private package | Nothing read it; see AC7 below |
| meeting-room sample (private) | `meetingRoomDeliveryPolicy` export and `meetingRoomRuntimeConfig.deliveryViews` removed; the in-process test seam `__G29_DOORBELL_TEST__.deliveryPolicy` is replaced by `domainViews` (view descriptors that still go through the helper) | Sample-only | The hand-kept map was a second policy source that nothing checked against `meetingRoomViews` |

`dcb-runtime` is `private: true` at version `0.1.0`; it was never published, so
its removals do not affect a published consumer.

## Changed existing assertions and checks

No existing assertion in `test/dcb-domain.spec.ts`, `test/g57-executor.spec.ts`
(including the conflict test at `:362`) or `test/g13-core.spec.ts` changed; those
files only gained imports and new tests.

| Location (before → after) | Before | After | AC |
| --- | --- | --- | --- |
| `test/g29-delivery.spec.ts:13` → `:13-14` | `import { meetingRoomDeliveryPolicy } from "../samples/meeting-room/src/domain"` | `import { deliveryPolicyFromDomain, type DomainViewDefinition } from "@sekiban/dcb-domain"` and `import { meetingRoomDomain } …` | AC7 |
| `test/g29-delivery.spec.ts:25` → `:26-30` | `const allQueued = { RoomProjector: "queued", ReservationProjector: "queued" }` | `meetingRoomViews = meetingRoomDomain.views`, `allQueuedViews` (the same views with `deliveryClass: "queued"`), `meetingRoomPolicy = deliveryPolicyFromDomain(meetingRoomDomain)` | AC7 |
| `test/g29-delivery.spec.ts:102-109` → `:107-114` | matrix cases carry `policy: meetingRoomDeliveryPolicy` / `policy: allQueued` | matrix cases carry `domainViews: meetingRoomViews` / `domainViews: allQueuedViews` | AC7 |
| `test/g29-delivery.spec.ts:112` → `:117` | `readDirectDoorbellConfig(value.env, value.domain, value.policy)` | `readDirectDoorbellConfig(value.env, value.domain, deliveryPolicyFromDomain({ views: value.domainViews }))` | AC7 |
| `test/g29-delivery.spec.ts:120` → `:125` | receiver seam `deliveryPolicy: value.policy` | receiver seam `domainViews: value.domainViews` | AC7 |
| `test/g29-delivery.spec.ts:141-142` → `:146-147` | C3 case `policy = { RoomProjector: "immediate-preferred", ReservationProjector: "queued" }` passed as `deliveryPolicy` | C3 case passes `domainViews` with RoomProjector `immediate-preferred` and ReservationProjector `queued`; expectations `directCalls = ["RoomProjector"]`, `queueCalls = ["ReservationProjector"]` unchanged | AC7 |
| `test/g29-delivery.spec.ts:160` → removed | barrier case passed `deliveryPolicy: meetingRoomDeliveryPolicy` | the seam input is omitted, so the production derived policy is used; the expected stages are unchanged | AC7 |
| `test/g29-delivery.spec.ts:191` → `:195`, `:203` → `:207` | third argument `meetingRoomDeliveryPolicy` | third argument `meetingRoomPolicy` (derived); expectations unchanged | AC7 |
| `test/g29-mapping.spec.ts:65` | `expect(execution.viewManifest).toEqual(meetingRoomRuntimeConfig.deliveryViews.map(…))` | `expect(execution.viewManifest).toEqual(meetingRoomDomain.views.map(…))` (authoring manifest against the emitted runtime descriptor) | AC7 |
| `samples/meeting-room/src/mapping-observation.ts:133`, `:273` → `:132`, `:272` | view-descriptor checks compare against `meetingRoomRuntimeConfig.deliveryViews.length` | compare against `meetingRoomDomain.views.length` | AC7 |
| `docs/SDT-G78-evidence.md` classification table | no `invalid_execute_options` row | row `invalid_execute_options` / definite-refusal | AC4 |
| `scripts/g78-error-classification-guard.mjs` `classifications` | no `invalid_execute_options` entry | entry `invalid_execute_options: definite-refusal`; the guard's derivation and self-test are unchanged, it only gains the row the new source code requires | AC4 |

The expected G29 matrix (`docs/SDT-G29-delivery-matrix.json`) is unchanged; the
new test `SDT-G88 AC7: derives the sample doorbell policy from the domain view
descriptors` asserts the derived sample policy equals its `descriptor`.

## AC-by-AC evidence

| AC | Change | Tests |
| --- | --- | --- |
| AC1 | `session.ts` `executeCommand` returns `status: "conflict"` with the last envelope and the conflict error when the last permitted attempt conflicts | `test/dcb-domain.spec.ts` "AC1: reports an exhausted consistency conflict as conflict, never accepted" (retries 0/1/2/omitted → attempts 1/2/3/2; `envelope` is the last one; `error` is the reply error); "AC1: still accepts a conflict followed by an accepted commit" |
| AC2 | `conflictRetryLimit` in `session.ts`, called first in `executeCommand` | `test/dcb-domain.spec.ts` "AC2: refuses an invalid maxConflictRetries before any read, handler call or commit" (NaN, +Infinity, -Infinity, -1, 0.5, 1.5, MAX_SAFE_INTEGER+1; zero parse, reads, snapshot reads, handler, commit and clock calls; `undefined`, 0, 1, 2, MAX_SAFE_INTEGER still run) |
| AC3 | `classifyCommitResult` in `session.ts` | `test/dcb-domain.spec.ts` "AC3: accepts only undefined, true and { kind: accepted }; every other reply is unknown" (accepted, unknown, own-error and recognised conflict/unknown/rejected classes) |
| AC4 | `executor.ts` `conflictResult`, status `conflict` branch, `EXECUTE_OPTIONS_INVALID` mapping; `bridge.ts` `runtimeOutcomeFrom` conflict branch; G78 row | `test/g57-executor.spec.ts` "SDT-G88 AC4: refuses an invalid maxConflictRetries as invalid_execute_options without a commit"; "SDT-G88 AC4: keeps an exhausted conflict typed for maxConflictRetries 1 and 2"; existing "AC2: exposes typed conflict details without retrying when retries are disabled" (`:362`, unchanged); `test/dcb-domain.spec.ts` "AC4: maps an always-conflicting runtime port to a rejected consistency_conflict outcome" (commit and conflict-barrier paths); `npm run test:g78` |
| AC5 | `state.ts` `stateUnion`/`StateUnion`; `states()` unchanged option; sample `domain.ts` drops `discriminator: "status"` | `test/dcb-domain.spec.ts` "AC5: leaves the discriminator to the zod union while states() keeps its option" (runtime: no `discriminator` member; compile time: `@ts-expect-error` on the removed option, enforced by `npm run typecheck`) |
| AC6 | `state.ts` `projector` initial resolution, definition-time parse, wrapped `deserializeState`; sample projectors and README drop the double initial | `test/dcb-domain.spec.ts` "AC6: supplies the projector initial state from state and validates it at definition"; "AC6: parses restored projector state and fails closed on a schema violation" (default and custom `deserializeState`, the runtime bridge projector, and the no-state projector unchanged); the meeting-room specs run the sample projectors without `initialState` |
| AC7 | `domain.ts` `ViewDeliveryClass`, validation in `domain()`, `deliveryPolicyFromDomain`; `bridge.ts` effective views; Cloudflare workers and receiver support call the helper; hand-kept map, `RuntimeWorkerConfig.deliveryViews` and `RuntimeDomainLike.views` removed | `test/dcb-domain.spec.ts` "AC7: validates view deliveryClass and derives the per-view delivery policy from the domain"; `test/g29-delivery.spec.ts` (all cases, now through the helper, including "keeps descriptor-absent legacy migration explicit", unchanged) and "SDT-G88 AC7: derives the sample doorbell policy from the domain view descriptors"; `test/g38-receiver-surface.spec.ts` (production receiver path) |
| AC8 | `packages/dcb-core/src/index.ts` `done`, `CommandDone`, `CommandCommitted`, explicit committed result, `TState` removal | `test/g13-core.spec.ts` "SDT-G88 AC8: builds the committed outcome from kind, value and events only" (`context.done`, exported `done` with a stray second argument, and a handler literal carrying `state`; compile-time `@ts-expect-error` on the removed parameter) |
| AC9 | `types.ts` removes `cloneAndFreeze` and makes `isJsonValue` cycle-safe; `event.ts` `frozenJsonCopy`; `session.ts` `serializeDecisionLog` | `test/dcb-domain.spec.ts` "AC9: keeps caller-owned objects mutable through event.make and serializeDecisionLog" (caller `z.unknown()`/`z.any()` objects stay mutable and the payload is an unaffected frozen copy; cyclic payload → `INVALID_JSON_VALUE`; handler `done` value, caller log and reject details stay mutable; cyclic reject details → `TypeError`) |
| AC10 | This document | Sections below |

### AC8: the TState generic

After `state` left `CommandDone` and `CommandCommitted`, `TState` no longer
shapes any member of any dcb-core command type. It is **removed**, not kept:

- It carries no meaning, which is the kind of declared-but-unimplemented
  surface SDT-G74 forbids at the v1 freeze.
- The repository lint gate rejects it: with the parameter kept, `npm run lint`
  failed with `'TState' is defined but never used
  @typescript-eslint/no-unused-vars` at `CommandCommitted` and `CommandDone`.
  Keeping it would have required a lint suppression.
- No code in this repository passes the type argument; `0.2.0` is already a
  breaking carrier. Code that writes `CommandDefinition<Input, State>` must drop
  the second argument.

### AC7: RuntimeDomainLike.views and RuntimeWorkerConfig.deliveryViews

Both are **removed** from `packages/dcb-runtime/src/composition.ts`. The
Cloudflare workers build the doorbell configuration in the sample
(`readDirectDoorbellConfig(env, domainDeliveryClass, policy)`), and the per-view
policy they pass is now `deliveryPolicyFromDomain(meetingRoomDomain)`, derived
from the runtime descriptor that `toRuntimeDomain` emits (the receiver support's
test seam substitutes view descriptors, which go through the same helper). No
runtime composition path reads a domain's views or a configured view list, so
neither field was read by that path; reading them would have meant adding a
second policy route inside the runtime. The descriptor-absent legacy path in
`Doorbell.ts` (`domainViewDeliveryClasses` omitted) is unchanged and still
covered by "keeps descriptor-absent legacy migration explicit".

## Red before green

The new tests were run against the unchanged implementation (`a0d6add` source,
tests added) before any source change:

```
$ npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts test/g13-core.spec.ts test/g57-executor.spec.ts test/g29-delivery.spec.ts
exit=1
 FAIL  test/g29-delivery.spec.ts [ test/g29-delivery.spec.ts ]
TypeError: deliveryPolicyFromDomain is not a function
 FAIL  … AC1: reports an exhausted consistency conflict as conflict, never accepted
AssertionError: maxConflictRetries=0: expected 'accepted' to be 'conflict' // Object.is equality
 FAIL  … AC2: refuses an invalid maxConflictRetries before any read, handler call or commit
AssertionError: NaN: expected undefined to be an instance of DomainAuthoringError
 FAIL  … AC3: accepts only undefined, true and { kind: accepted }; every other reply is unknown
AssertionError: null: expected 'accepted' to be 'unknown' // Object.is equality
 FAIL  … AC4: maps an always-conflicting runtime port to a rejected consistency_conflict outcome
AssertionError: expected { kind: 'committed', …(2) } to match object { kind: 'rejected', …(2) }
 FAIL  … AC5: leaves the discriminator to the zod union while states() keeps its option
AssertionError: expected { kind: 'state-union', …(4) } to not have property "discriminator"
 FAIL  … AC6: supplies the projector initial state from state and validates it at definition
DomainAuthoringError: Projector initial state is required
 FAIL  … AC6: parses restored projector state and fails closed on a schema violation
AssertionError: expected [Function] to throw an error
 FAIL  … AC7: validates view deliveryClass and derives the per-view delivery policy from the domain
TypeError: deliveryPolicyFromDomain is not a function
 FAIL  … AC9: keeps caller-owned objects mutable through event.make and serializeDecisionLog
AssertionError: expected true to be false // Object.is equality
 FAIL  test/g13-core.spec.ts > … SDT-G88 AC8: builds the committed outcome from kind, value and events only
AssertionError: exported: expected { kind: 'committed', …(3) } to not have property "state"
 FAIL  test/g57-executor.spec.ts > … SDT-G88 AC4: refuses an invalid maxConflictRetries as invalid_execute_options without a commit
AssertionError: NaN: expected { Object (kind, attempts, ...) } to match object { kind: 'invalid', attempts: +0, …(1) }
-   "attempts": 0,
-   "code": "invalid_execute_options",
-   "kind": "invalid",
+   "attempts": 1,
+   "kind": "committed",
 Test Files  4 failed (4)
      Tests  11 failed | 32 passed (43)
```

The facade failure reproduces the defect named in the issue: `maxConflictRetries: NaN`
with a 409 `consistency_conflict` reply returned `kind: "committed"` after one
commit. "SDT-G88 AC4: keeps an exhausted conflict typed for maxConflictRetries 1
and 2" passed on the unchanged code as well, as expected: the facade's
commit-closure conversion already produced `conflict` there, and the test guards
that it keeps doing so.

## Mutants (AC10)

Each mutant was applied to the committed implementation by a scratch script
that replaces an exact anchor (required to occur once), runs
`npm run build:packages`, runs the named tests, restores the original bytes,
checks their SHA-256, and rebuilds. Every mutant reported `restored=True`
and `rebuildExit=0`, and `git status --short` was empty afterwards.

### AC1 — restore the fall-through to accepted

`packages/dcb-domain/src/session.ts`: the conflict block becomes
`if (commitResult.kind === "consistency-conflict" && attempts <= maxRetries) continue;`.

```
$ npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts -t AC1
exit=1
     × AC1: reports an exhausted consistency conflict as conflict, never accepted 5ms
 FAIL  test/dcb-domain.spec.ts > SDT-G88 command outcomes and authoring options > AC1: reports an exhausted consistency conflict as conflict, never accepted
AssertionError: maxConflictRetries=0: expected 'accepted' to be 'conflict' // Object.is equality
Expected: "conflict"
Received: "accepted"
 ❯ test/dcb-domain.spec.ts:807:36
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 28 skipped (30)
```

### AC2 — restore `Math.floor` normalisation

`session.ts`: `const maxRetries = Math.max(0, Math.floor(options.maxConflictRetries ?? 1));`.

```
$ npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts test/g57-executor.spec.ts -t AC2|AC4: refuses an invalid maxConflictRetries
exit=1
     × SDT-G88 AC4: refuses an invalid maxConflictRetries as invalid_execute_options without a commit 3ms
     × AC2: refuses an invalid maxConflictRetries before any read, handler call or commit 3ms
 FAIL  test/dcb-domain.spec.ts > SDT-G88 command outcomes and authoring options > AC2: refuses an invalid maxConflictRetries before any read, handler call or commit
AssertionError: NaN: expected undefined to be an instance of DomainAuthoringError
 ❯ test/dcb-domain.spec.ts:878:51
 FAIL  test/g57-executor.spec.ts > SDT-G57 executor facade deploy-free contract > SDT-G88 AC4: refuses an invalid maxConflictRetries as invalid_execute_options without a commit
AssertionError: NaN: expected { kind: 'conflict', attempts: 1, …(3) } to match object { kind: 'invalid', attempts: +0, …(1) }
-   "attempts": 0,
-   "code": "invalid_execute_options",
-   "kind": "invalid",
+   "attempts": 1,
+   "code": "consistency_conflict",
+   "kind": "conflict",
 ❯ test/g57-executor.spec.ts:396:50
 Test Files  2 failed (2)
      Tests  2 failed | 3 passed | 32 skipped (37)
```

### AC3 — restore accepted-by-default

`session.ts` `classifyCommitResult`: non-object replies return `{ kind: "accepted" }`
and the final unrecognised-object branch returns `{ kind: "accepted" }`.

```
$ npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts -t AC3
exit=1
     × AC3: accepts only undefined, true and { kind: accepted }; every other reply is unknown 5ms
 FAIL  test/dcb-domain.spec.ts > SDT-G88 command outcomes and authoring options > AC3: accepts only undefined, true and { kind: accepted }; every other reply is unknown
AssertionError: null: expected 'accepted' to be 'unknown' // Object.is equality
Expected: "unknown"
Received: "accepted"
 ❯ test/dcb-domain.spec.ts:905:52
 Test Files  1 failed (1)
      Tests  1 failed | 29 skipped (30)
```

### AC6 — skip parsing restored state

`packages/dcb-domain/src/state.ts`: `const deserializeState = restoreState;`.

```
$ npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts -t AC6
exit=1
     × AC6: parses restored projector state and fails closed on a schema violation 3ms
 FAIL  test/dcb-domain.spec.ts > SDT-G88 command outcomes and authoring options > AC6: parses restored projector state and fails closed on a schema violation
AssertionError: expected [Function] to throw an error
 ❯ test/dcb-domain.spec.ts:1033:87
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 28 skipped (30)
```

### AC7 — reintroduce the duplicate policy map as the source

`samples/meeting-room/src/domain.ts` regains
`export const meetingRoomDeliveryPolicy = { RoomProjector: "immediate-preferred", ReservationProjector: "immediate-preferred" }`,
and `worker.cloudflare-receiver-support.ts` passes `meetingRoomDeliveryPolicy`
to `readDirectDoorbellConfig` instead of
`deliveryPolicyFromDomain({ views: env.__G29_DOORBELL_TEST__?.domainViews ?? meetingRoomDomain.views })`.

```
$ npx vitest run --config vitest.config.ts test/g29-delivery.spec.ts
exit=1
     × keeps the C3 Room-only/Reservation-queued regression visible through MeetingRoomDownstreamDoorbell.deliver 3ms
 FAIL  test/g29-delivery.spec.ts > SDT-G29 per-view delivery policy > keeps the C3 Room-only/Reservation-queued regression visible through MeetingRoomDownstreamDoorbell.deliver
AssertionError: expected [ 'RoomProjector', …(1) ] to deeply equal [ 'RoomProjector' ]
- Expected
+ Received
+   "ReservationProjector",
 ❯ test/g29-delivery.spec.ts:149:25
 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
```

The map ignores the views' declared classes, so a Reservation view declared
`queued` was delivered directly.

### Supplementary (not a required mutant): the facade's new conflict mapping

With the facade's commit-closure conversion removed
(`return { kind: "consistency-conflict", error: decision.error };` for every
conflict), the facade conflict tests stay green, which shows the new status
`conflict` mapping alone yields the typed conflict SDT-G86 will rely on:

```
$ npx vitest run --config vitest.config.ts test/g57-executor.spec.ts -t conflict
exit=0
 Test Files  1 passed (1)
      Tests  2 passed | 5 skipped (7)
```

## Verification

Run on the implementation commit (exit codes as reported by the shell):

| Command | Exit | Key output |
| --- | --- | --- |
| `npm run build:packages` | 0 | |
| `npm run test:g57` | 0 | `Tests 7 passed (7)`; `g57-executor-path-valid`, self-test mutant red |
| `npm run test:g71` | 0 | `Tests 16 passed (16)`; `all-g71-behavioral-product-mutants-red` |
| `npm run test:g78` | 0 | `Tests 9 passed (9)`; `g78-error-classification-valid` (derived codes include `invalid_execute_options` from `executor.ts:result code`); packed consumer `PASS` |
| `npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts test/g29-delivery.spec.ts test/g29-meeting-room.spec.ts test/g29-mapping.spec.ts test/g29-witness.spec.ts test/meeting-room.spec.ts test/g31-sample.spec.ts test/g13-core.spec.ts test/g13-client.spec.ts` | 0 | `Test Files 9 passed (9)`, `Tests 171 passed (171)` |
| `npx vitest run --config vitest.config.ts test/d1-mv.spec.ts test/g38-receiver-surface.spec.ts test/g65-ring-apply.spec.ts test/g67-safe-lane.spec.ts test/g69-ordering.spec.ts test/g27-identity.spec.ts test/g13-public-shape.spec.ts test/g31-waitfor.spec.ts test/g31-witness.spec.ts test/g26-doorbell.spec.ts test/g26-integration.spec.ts test/g26-delivery.spec.ts` | 0 | `Test Files 12 passed (12)`, `Tests 108 passed (108)` |
| `npx vitest run --config vitest.g20.config.ts test/g20-cloudflare.spec.ts` | 0 | `Tests 2 passed (2)` |
| `npm run test:g28:compile-fail`, `test:g28:boundaries`, `test:g28:boundary:source`, `test:g28:boundary:negative`, `test:g28:boundary:package` | 0 each | |
| `npm run test:g29:mapping:runner`, `node scripts/g29-delivery-matrix.mjs`, `npm run test:g29:domain-source`, `npm run test:g29:authoring-doc` | 0 each | |
| `npm run test:g59`, `npm run test:consumer`, `npm run test:boundaries`, `npm run test:g64:build`, `npm run test:g64:pack`, `npm run test:g64:consumer` | 0 each | |
| `npm run lint` | 0 | |
| `npm run typecheck` | 0 | the `@ts-expect-error` lines for the removed `stateUnion` option and `done` parameter are enforced here |
| `git diff --check origin/main...HEAD` | 0 | no output |
| `npm test` (full suite, implementation commit `fd54955`) | 1 | `Test Files 10 failed \| 90 passed \| 1 skipped (101)`, `Tests 34 failed \| 822 passed \| 1 skipped (857)`; see below |

### Full-suite failures are environmental

Docker was not running on the machine, so the local PostgreSQL behind the
Hyperdrive binding (`127.0.0.1:54329`) was unreachable; 28 of the full-run
errors are `Error: proxy request failed, cannot connect to the specified address`.
None of the ten failing files (`bootstrap`, `commit`, `downstream`,
`g17-lineage`, `g22-bootstrap-provider`, `mv`, `projection`, `query`, `read`,
`tag`) imports a symbol this unit changed. To separate environment from change,
those ten files were run on their own at the base commit and at the
implementation commit in this worktree:

```
base a0d6add:           Test Files  8 failed | 2 passed (10)   Tests  32 failed | 46 passed (78)
implementation fd54955: Test Files  8 failed | 2 passed (10)   Tests  32 failed | 46 passed (78)
```

The sorted `FAIL` lists of the two runs are identical (`diff` printed nothing).
The two further failures seen only in the full run, `commit.spec.ts` "AC7:
allocation and cancellation faults …" and `tag.spec.ts` "G5: treats fences as an
exact-key durable set …", were `Error: Test timed out in 5000ms.` under full
parallel load; both files passed in the ten-file run at the implementation commit.
A full suite with PostgreSQL available was not run locally; exact-head CI is the
authority for it.

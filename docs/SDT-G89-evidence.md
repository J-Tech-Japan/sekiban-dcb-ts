# SDT-G89 evidence

Issue: J-Tech-Japan/sekiban-dcb-ts#183. Baseline: published `0.1.0`;
implementation base: SDT-G87 `2f6b7dd`.

## Public surface changes

| Surface | Compatibility | Reason |
| --- | --- | --- |
| `RuntimeProjectionEvent` drops `eventId` and `suid` | Breaking | SUID and event id belong to the host allocator (means/23); the bridge never read them. |
| `RuntimeCommandPortResult` split into `RuntimePortBarrierResult`, `RuntimePortAdmitResult`, `RuntimePortCommitResult` | Breaking refinement | `accepted.attemptId` is declared only on callbacks whose attempt id the bridge reads; commit `accepted` and reconcile `accepted` omit it; `consistency-conflict` / `rejected` `error` members removed where unread. |
| `RuntimeCommandPort.reconcile` returns `RuntimePortReconcileResult` | Breaking refinement | Reconcile does not read commit `accepted.attemptId`; result type matches commit minus that field. |
| `RuntimeCommandPort` callback result types follow the split above | Breaking refinement | Same as the port-result split; aligns `createRuntimeCommitPort` in dcb-runtime. |
| `RuntimeCommitPortResult.accepted` drops `attemptId` | Breaking refinement | The commit adapter's accepted arm is unread; unknown `attemptId` remains for reconcile precedence. |
| Barrier/admit `unknown` reconcile context uses `attemptId = candidateKey` | Behavioral correction | Those callbacks never declared `unknown.attemptId`; reconcile still receives a stable attempt key from the candidate envelope. |
| `adaptRuntimeCommand` rejected output carries port `reason` and `code` | Behavioral correction | SDT-G88 made `ExecuteCommandResult.error` the reply error; the bridge keeps the port result separately. |
| Bridged projector `apply` validates `eventPayloadName`, `provenance`, and `eventTags` | Additive behavior | Stored tags are the authority (means/15, SDT-G32); empty `eventTags` throws `RUNTIME_EVENT_TAGS_EMPTY`; malformed stored tags throw from `normalizeTag`. |
| `ProjectionCheckpointCorruption` export | Additive | Checkpoint deserialize/validation failures map to a stable runtime error instead of leaking raw parse/validation errors. |
| Legacy `eventName` registration (`name ?? eventName ?? eventPayloadName`) | Additive behavior | SDT-G28 keeps the old API; dcb-core already accepts `eventName`. |
| Legacy `LegacyEventDefinition.create` / `construct` omit name fields on the input type | Breaking refinement | Only `payload` is read from legacy construction; name fields stay on the resolved registration, not the construction return type. |
| Authoring bridged `create()` / `construct()` return derived `tags` | Behavioral correction | Tags were always derived in authoring but returned `[]` at the bridge. |
| `deliveryPolicyFromDomain` uses `Object.create(null)` | Behavioral correction | A view id such as `__proto__` must remain a real key (SDT-G88 review follow-up). |
| `SekibanExecutor.execute` maps live-read `INCOHERENT_SNAPSHOT` to `transport` / `incoherent_read_snapshot` | Behavioral correction | G86 review N6: adapter-backed read-through incoherence is transport-classified; supplied/snapshot-only stays `invalid` / `domain_authoring_error`. |

These breaks are carried by `0.2.0`. They are not compatible fixes for the published `0.1.0` declarations.

## SekibanWasmRuntime impact

A consumer that pins `samples/meeting-room/src/domain.ts` and calls bridged projectors through a WebAssembly guest whose event ABI carries only `eventType` and `payload` (as SekibanWasmRuntime does today, often passing `eventTags: []`):

1. After this unit, an **explicitly empty** `eventTags: []` throws `RUNTIME_EVENT_TAGS_EMPTY` instead of silently folding nothing.
2. The two sanctioned responses are: **extend the ABI** to pass stored tags, or **omit `eventTags`** and rely on the host's per-tag routing (`ProjectionRuntime` routes before `apply`; the bridge keeps the synthetic `<family>:__runtime__` tag only when `eventTags` is absent).
3. `eventId` and `suid` are no longer declared on `RuntimeProjectionEvent`.

The composed meeting-room path test proves family safety when stored `eventTags` reach a subscribed projector through `composeRuntime`: a foreign-family tag preserves state, an own-family tag folds, and an empty list throws.

## Criteria and tests

| Criterion | Production | Tests |
| --- | --- | --- |
| AC1 | `bridge.ts` `portRejectionFields`, `lastPortResult` capture in `adaptRuntimeCommand` | `test/dcb-domain.spec.ts` "AC1: reports a port rejection reason and code from the port result, not the unwrapped error" |
| AC2 | Split port result types; reconcile attempt id precedence `commit.attemptId ?? allocation.attemptId ?? admit.attemptId`; `composition.ts` `RuntimeCommitPortResult` aligned | `test/dcb-domain.spec.ts` AC2 precedence table, commit accepted type check, barrier zero-call regression |
| AC3 | `freezeAllocation` copies the exact vector | `test/dcb-domain.spec.ts` "AC3: passes the exact allocated vector into commit and reconcile" |
| AC4 | `runtimeProjectorFrom` validation and tag folding; `composition.ts` passes `eventTags` and `provenance` through bridged projectors | `test/dcb-domain.spec.ts` "AC4: validates projection event facts and folds by non-empty eventTags"; `test/g29-meeting-room.spec.ts` composed foreign/own-family and empty-tag cases |
| AC5 | `runtimeEventFrom` name resolution; legacy create shape narrowed on `LegacyEventDefinition` only | `test/dcb-domain.spec.ts` "AC5: registers legacy eventName and omits name fields from legacy create()" |
| AC6 | Authoring `create()` / `construct()` keep derived tags | `test/dcb-domain.spec.ts` "AC6: bridged authoring events keep derived tags on create() and construct()" |
| AC7 | This document; `packages/dcb-domain/README.md`; `docs/domain-authoring.md` legacy path note | README frozen-surface list updated |
| AC8 | Full suites below | Mutants in the next section |
| AC9(a) | `deliveryPolicyFromDomain` null-prototype policy object | `test/dcb-domain.spec.ts` "AC9(a): deliveryPolicyFromDomain keeps a __proto__ view id" |
| AC9(b) | TagState corrupt path; `ProjectionRuntime.stateFromCheckpoint` wraps deserialize failures | `test/g46-tagstate.spec.ts`; `test/projection.spec.ts` zod-invalid checkpoint case |
| AC9(c) | `scripts/g89-doorbell-policy-guard.mjs` wired as `npm run test:g89:doorbell-guard` in PR-tier CI | Guard self-test rejects variable-held, Object.freeze, and single-site literal maps |
| AC10 | This document | intent-cli worker claim held; PR against `main` |
| AC11 | `packages/dcb-client/src/executor.ts` live-read `INCOHERENT_SNAPSHOT` mapping | `test/g57-executor.spec.ts` live-read transport classification, supplied-snapshot `domain_authoring_error`, concurrent-write recovery |

## Existing assertions changed

| Before | After | Criterion |
| --- | --- | --- |
| Port rejection always `Command was rejected` / `command_rejected` | Port `reason` and `code` surface when present | AC1 |
| `RuntimeCommandPortResult` single union with unread `error` / `attemptId` fields | Split per-callback result types | AC2 |
| Commit `accepted` and reconcile result declared `accepted.attemptId` | Commit/reconcile `accepted` omit `attemptId`; unknown commit keeps it | AC2 |
| Barrier exhausted-conflict regression counted barriers only | Also asserts `admit`, `allocate`, and `commit` are never called | AC2 |
| Reconcile precedence tested with admit id only | Table test with three distinct ids across commit/allocation/admit | AC2 |
| Bridged projector ignored `eventTags` and used synthetic tag for every event | Non-empty stored tags fold; empty list throws; absent tags keep synthetic legacy path | AC4 |
| Composed foreign-family test used reservation tag on ReservationProjector (own family) | Foreign-family tag on subscribed projector preserves state through `composeRuntime` | AC4 |
| Legacy `eventName`-only events threw `EVENT_NAME_INVALID` | Register under `eventName` | AC5 |
| `RuntimeEventValue.eventName` / `eventPayloadName` made optional in authoring | Reverted; narrowing stays on `LegacyEventDefinition` construction type only | AC5 |
| Bridged authoring `create()` returned `tags: []` | Returns derived tags | AC6 |
| G88 barrier conflict outcome included unread `error` member | `{ kind: "consistency-conflict" }` only | AC2 |
| Live-read `INCOHERENT_SNAPSHOT` was `invalid` / `domain_authoring_error` | Adapter-backed read-through without supplied snapshots is `transport` / `incoherent_read_snapshot` | AC11 |

## Mutation evidence

Each mutation was applied to production source, the named focused test was run, the mutation was restored, and the final positive suite was rerun.

1. **AC1** — read rejection `reason`/`code` from the unwrapped `error`. Red:
   `expected code "barrier_code"; received "x"` and `reason "Command was rejected"`
   (`test/dcb-domain.spec.ts:1262`).
2. **AC3** — drop `allocatorLineageId` from `freezeAllocation`. Red:
   `expect(commitVector).toEqual(vector)` allocatorLineageId mismatch
   (`test/dcb-domain.spec.ts:1318`).
3. **AC4 (ignore tags)** — always use synthetic `__runtime__` tag. Red:
   foreign tag folded to placed state instead of empty
   (`test/dcb-domain.spec.ts:1333`).
4. **AC4 (empty list)** — accept `eventTags: []` silently. Red:
   `expected RUNTIME_EVENT_TAGS_EMPTY; received no throw`
   (`test/dcb-domain.spec.ts:1331`).
5. **AC4 (composed path drop eventTags)** — omit `eventTags` from composed bridged call. Red:
   foreign `room:` tag folds reservation state instead of preserving initial state
   (`test/g29-meeting-room.spec.ts` AC4 composed case).
6. **AC5** — revert to `name ?? eventPayloadName`. Red:
   `DomainAuthoringError EVENT_NAME_INVALID` for legacy-only `eventName`
   (`test/dcb-domain.spec.ts:1341`).
7. **AC6** — return `tags: []` from authoring `create()`. Red:
   `expected ["order:room1"]; received []`
   (`test/dcb-domain.spec.ts:1357`).
8. **AC2 (precedence reversal)** — use `admitted.attemptId ?? allocation?.attemptId ?? committed.attemptId`. Red:
   expected `commit-unknown-attempt`; received `admit-attempt`
   (`test/dcb-domain.spec.ts` AC2 precedence table).
9. **AC2 (barrier fall-through)** — return `{ kind: "accepted" }` from always-conflicting barrier. Red:
   `barrierAdmits`/`barrierCommits` > 0 or outcome not `consistency_conflict`
   (`test/dcb-domain.spec.ts` barrier regression).
10. **AC9(b)** — remove `stateFromCheckpoint` try/catch. Red:
    raw Zod validation error instead of `ProjectionCheckpointCorruption`
    (`test/projection.spec.ts` AC9(b)).
11. **AC9(c)** — variable-held / Object.freeze / single-site literal policy maps. Red:
    guard rejects hand-kept per-view policy
    (`scripts/g89-doorbell-policy-guard.mjs` self-test).
12. **AC11** — map live-read `INCOHERENT_SNAPSHOT` to `domain_authoring_error`. Red:
    `expected kind transport / incoherent_read_snapshot; received invalid / domain_authoring_error`
    (`test/g57-executor.spec.ts:912`).

## Verification

- `npm run test:g57` — 16 passed + path guards
- `npm run test:g71` — 17 passed + mutation runner
- `npm run test:g78` — passed + guards
- `npx vitest run --config vitest.config.ts test/dcb-domain.spec.ts test/g29-meeting-room.spec.ts test/meeting-room.spec.ts test/projection.spec.ts --testNamePattern "SDT-G89|AC2: reconcile|AC4: maps an always-conflicting|AC5: registers legacy"` — focused G89 specs
- `npm run test:g89:doorbell-guard` — pass (three mutants red)
- `node scripts/dcb-domain-consumer-check.mjs` — PASS
- `node scripts/dcb-matched-set-consumer-check.mjs` — PASS
- `npm run lint`
- `npm run typecheck`
- `git diff --check origin/main`

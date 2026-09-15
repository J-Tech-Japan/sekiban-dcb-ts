# SDT-G87 evidence

Issue: J-Tech-Japan/sekiban-dcb-ts#181. Baseline: published `0.1.0`;
implementation base: SDT-G86 `5da349b`.

## Public surface changes

| Surface | Compatibility | Reason |
| --- | --- | --- |
| `ClaimLedgerExecutor.execute` accepts only a command function; `CommandLike` no longer includes dcb-core `CommandDefinition` | Breaking | A core command cannot expose the ledger claims needed to preserve `assertEmpty`; committing only its events would silently discard consistency protection. JavaScript non-functions are refused as `invalid / unsupported_command` before transport. |
| dcb-client re-exports of `CommandDefinition` and `CommandOutcome` | Breaking removal | No remaining dcb-client API uses them after removal of the impossible executor arm. The other dcb-core type re-exports remain. |
| `ClientCommandDecision` has no `envelope` member | Breaking | SDT-G13 permits one context-owned append/claim path. A handler may not hand-write consistency heads or candidates. |
| `ExecuteCommitted.value` on ledger results | Additive behavior on the SDT-G86 additive field | A committed/done decision value is now preserved; the member is absent when no value was returned. |
| `ExecuteOptions.maxConflictRetries` documentation and validation | Behavioral tightening | Undefined means zero retries for `ClaimLedgerExecutor`; every supplied value must be a non-negative safe integer and values above one are capped at one retry. `SekibanExecutor` differs: default one and no cap. |
| `ClaimLedgerExecutorOptions.maxConflictRetries` documentation and validation | Behavioral tightening | Constructor defaults obey the same rule and are validated at execute time before command or transport work. |
| `CommitHttpResult.headers` documentation | Documentation only | Built-in HTTP adapters populate headers on every HTTP result. Headers are transport metadata and are never copied into `ClientError` or executor results. |
| `ExecuteCommon.cause` | Breaking removal | SDT-G78 redaction deliberately stopped exposing causes and no implementation filled the field. |
| `ExecuteConflict.response` | Breaking removal | No implementation filled the field after SDT-G78; conflict results expose only classified public facts. |
| `SerializedDcbClient.commit` result | Behavioral correction | It now returns the HTTP-shaped adapter result, including headers, so unknown non-HTTP values cannot be mistaken for proof of commit. |

These breaks are carried by `0.2.0`. They are not compatible fixes for the
published `0.1.0` declarations.

## Criteria and tests

- AC1: `test/g13-client.spec.ts` refuses a command object with attempts zero and
  no commit. `unsupported_command` is in the shared classification module,
  G78 evidence table, and source-derived guard.
- AC2/AC3: the same spec passes a JavaScript extra `envelope`, proves the
  ledger head and context candidates win, and checks present/absent decision
  values.
- AC4: values 0, 1, and 2 prove the one-retry cap; NaN, Infinity, negative, and
  fractional values are refused from both call and constructor options.
- AC5: fake timers and a controlled random source prove a 25 ms draw from the
  uniform `[0, 50]` ms range, plus budget and abort cancellation without retry.
- AC6: an adapter observes the combined signal abort during `state`; no commit
  occurs. Either the execute signal or handler read signal can abort it.
- AC7: createHttpTransport and createInProcessTransport both retain a response
  header; the executor result has no headers. Existing meeting-room admission
  header coverage remains in `test/meeting-room.spec.ts`.
- AC8: SerializedDcbClient strips all trailing slashes, invokes default fetch
  with `globalThis`, sends the shared V1 body, and returns headers. The runtime
  validator accepts that body and returns HTTP 400 `malformed_commit_envelope`
  for the old client-model body.
- AC9: package build and typecheck prove the derived facade result types compile
  after both dead fields are removed.
- AC11: `test/g78-error-classification.spec.ts` proves a bogus discarded
  decision is `transport / invalid_command_result` with no commit, a thrown
  `consistency_conflict` retries and commits on attempt two, and both executors
  classify non-HTTP commit replies as `timeout / unknown_outcome`. Facade catch
  paths for `invalid_execute_options`, `invalid_command_input`, and
  `domain_authoring_error` call the shared classifier. Caller action for
  `invalid_command_result`: reconcile; do not treat it as definite refusal of
  the command text.

## Existing assertions changed

| Before | After | Criterion |
| --- | --- | --- |
| non-function/core command could resolve `noop`, attempts 1 | `invalid / unsupported_command`, attempts 0 | AC1 |
| handler `envelope.consistency` replaced ledger claims | extra JavaScript member is ignored | AC2 |
| committed ledger result dropped decision value | value is retained when present | AC3 |
| invalid retry values were silently clamped | `invalid / invalid_execute_options`, attempts 0 | AC4 |
| conflict retried immediately | bounded full-jitter delay precedes retry | AC5 |
| arbitrary non-HTTP commit value was committed | `timeout / unknown_outcome` | AC11(d) |

## Mutation evidence

Each mutation was applied to production source, the named focused test was run,
the mutation was restored, and the final positive suite was rerun.

1. AC1 — restored the historical silent noop for a non-function. Red:
   `expected { kind: 'noop', attempts: 1 } to match { kind: 'invalid',
   attempts: 0, code: 'unsupported_command' }`
   (`test/g13-client.spec.ts:295`).
2. AC2 — restored `decision.envelope.consistency` precedence. Red:
   `expected lastSortableUniqueId "ledger-head"; received "forged-head"`
   (`test/g13-client.spec.ts:323`).
3. AC4 — removed retry-value validation (historical NaN clamp). Red:
   `per-call NaN: expected invalid / invalid_execute_options / attempts 0;
   received conflict / consistency_conflict / attempts 1`
   (`test/g13-client.spec.ts:365`).
4. AC5 — skipped `waitBeforeConflictRetry`. Red:
   `expected commits 1; received 2` after only 24 ms
   (`test/g13-client.spec.ts:391`).
5. AC8 — restored `JSON.stringify(request)` in SerializedDcbClient. Red:
   expected V1 `version`, `eventCandidates`, and `consistencyTags`; received
   legacy `candidates` and `consistency` (`test/g13-client.spec.ts:495`).
6. AC11(b) — changed shared `invalid_execute_options` kind from `invalid` to
   `transport`. Red: expected kind `invalid`; received `transport`, while code
   and attempts remained `invalid_execute_options` and zero
   (`test/g57-executor.spec.ts:397`, facade path).

The captured Vitest runs each exited 1 with one failed focused test. After every
run, the production mutation was restored before the next mutation.

## Verification

Final command outputs are recorded in the implementation commit/report:

- `npx vitest run --config vitest.config.ts test/g13-client.spec.ts test/g13-core.spec.ts`
- `npm run test:g57`
- `npm run test:g71`
- `npm run test:g78`
- meeting-room specs
- `npm run lint`
- `npm run typecheck`
- `git diff --check origin/main...HEAD`

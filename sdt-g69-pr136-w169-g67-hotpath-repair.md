# SDT-G69-PR136-W169-G22-FAIL-BEFORE-BATCH-REPAIR

- Task: `SDT-G69-PR136-W169-G22-FAIL-BEFORE-BATCH-REPAIR`
- PR: J-Tech-Japan/sekiban-dcb-ts#136
- Initial reviewed head: `9eb872144819e07ab639241716c98fa2c4464f1d`
- Repair source head: `46fdc0df3b7f8c88b476a83b9125db8fe88906ea` (`fix(g69): preserve fail-before-batch identity guard`)
- Scope: G22 fail-before-batch correctness and the already-scoped G69 diagnostic hot-path repair. No deployment, Wrangler, Cloudflare, resource, fixture, timeout, SafeWindow, fence, retry, or drain operation was performed.

## Diagnosis

The first W169 hot-path commit deferred the G69 admission-attempt receipt correctly, but it also removed the pre-existing `storedBefore` canonical-identity preflight from `D1EventStore.recordDeliveryCore`. The retained post-batch identity check then discovered a replay with the same event ID and changed event type only after the D1 batch had started. That violated the G22 fail-before-batch contract: `test/g22-bootstrap-d1.spec.ts` expected `recordBatchStarts === 0` and observed `1`.

This is PR-caused, not the unrelated G54 flake. The hosted failure was:

`https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34212682714/job/102017113356`

`test/g22-bootstrap-d1.spec.ts` / “attributes canonical-key divergence to the D1 fail-before-batch guard”, line 65: expected `0`, received `1`; the test otherwise reported 1 failed and 6 passed in that file/lane.

## Narrow repair

The repair restores the pre-existing `storedBefore` canonical identity check before the durable `recordDelivery` batch. It checks the same event type, SUID, payload, tags, digest (when applicable), timestamp, causation ID, correlation ID, and executed user, and throws `D1IdentityConflictError` before any D1 mutation. The existing post-batch identity check remains as a second defense. The G22 test and its expected zero-mutation assertion are unchanged.

The G69 receipt remains outside the awaited delivery turn: `bestEffortG69AdmissionAttempt` is created through a deferred promise and is owned by `waitUntil` (or deliberately fire-and-forget when no lifetime hook exists). There is no G69 diagnostic pre-read before core admission and no diagnostic receipt is awaited by Queue delivery. The restored preflight is an existing correctness guard, not G69 diagnostic work; it is required to reject canonical identity conflicts before mutation.

The G65 mutation runner now disables both the preflight and post-batch identity checks and changes the event conflict action to overwrite. This keeps the production idempotence mutant red against the real shared-D1 replay/conflict oracle while preserving the production guards.

W169’s unconditional default-path pre-apply `ORDER_VIOLATION` walk/rejection/incident record remains intact. The late-lower database query remains explicit proof-only/off production; no SafeWindow, fence, retry, drain, or G67 test/timeout semantics changed.

## Local evidence

All commands below were run serially so mutation runners could not mutate the same source concurrently.

| Command | Result |
| --- | --- |
| `npm exec vitest run --config vitest.config.ts test/g22-bootstrap-d1.spec.ts --no-file-parallelism --maxWorkers=1` | 2/2 passed; canonical-key divergence completed with zero batch starts |
| `npm exec vitest run --config vitest.config.ts test/g67-safe-lane.spec.ts --no-file-parallelism --maxWorkers=1` | 11/11 passed; unchanged 5,000 ms guard |
| `npm exec vitest run --config vitest.g69.config.ts test/g69-ordering.spec.ts --no-file-parallelism --maxWorkers=1` | 8/8 passed |
| `npm run test:g69` | Passed; all six G69 mutants red: unconditional batch order, late-lower detector, higher-SUID lag exclusion, monotonic observed clock, append-only receipt, and awaited diagnostic |
| `node scripts/g65-admission-mutation-runner.mjs` | Passed; real production idempotence-removal mutant red-before-green (exit 1), baseline green |
| `node --check scripts/g65-admission-mutation-runner.mjs` | Passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `git diff --check` | Passed |

The G67 mutation receipt also recorded all seven existing G67 mutants red, including omitted kick, cron bypass/coalescing, BLOCK frontier advance, awaited Queue hook, omitted effective catch-up, and omitted fence-expiry trigger. No G67 assertion or timeout was edited.

## Exact-head CI history

The first exact-head CI run for `9eb872144819e07ab639241716c98fa2c4464f1d` was `34212682714`; its G22 failure is the diagnosis above. The replacement run for repair head `46fdc0d` is required to reach terminal state after push. Its URL and job results will be appended without changing this source/evidence scope.

## Boundaries preserved

- No Wrangler, Cloudflare, deployment, resource, PR review, merge, or lifecycle mutation was performed.
- No G22 test, G67 test, assertion, timeout, scheduler expectation, SafeWindow, fence, retry, or drain behavior was weakened.
- Existing unrelated dirty/untracked evidence was preserved and is not included in this checkpoint.

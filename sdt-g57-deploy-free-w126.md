# SDT-G57 deploy-free checkpoint W126

## Checkpoint

- Task: `SDT-G57-DEPLOY-FREE-WAKE-126`
- Issue: `J-Tech-Japan/sekiban-dcb-ts#123`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Base: `origin/main` at `4687efa5c49951d9966a3785be5fd7b2620c6e4f`
- Pushed implementation checkpoint: `cfe731d0105a9ff3beba7fbdf353d108f38354b7`
- Scope: deploy-free AC1–AC4 and the local/non-deployment portion of AC7.
- No PR was opened, no worker-completion transition was run, and AC5/AC6 were not started.

The host supplied ownership of `execution-unit:SDT-G57` to
`codex-net-orchestration / sekiban-dcb-ts-orch`. The child issue preflight was
actionable (`ready-to-implement`), and the canonical child issue claim added
`intent-issue-in-progress`. No Wrangler, Cloudflare, deployment, or remote
resource operation was performed.

## C-12 red-first proof

The red receipt is tracked at
`test/fixtures/g57-ac1-ac4-red-before-green.txt`. Before the implementation,
the exact focused command exited 1 with four expected missing-facade failures:

```text
npx vitest run --config vitest.config.ts test/g57-executor.spec.ts
exitCode: 1
TypeError: createInProcessTransport is not a function
TypeError: createSekibanExecutor is not a function
TypeError: createSekibanCloudTransport is not a function
```

After implementation, the same focused guard passed: 1 test file and 5 tests
passed. The red receipt remains unchanged and is not replaced by the green
run.

## AC mapping

### AC1 — executor facade and V1 transport parity

Added the public `SekibanExecutor` facade and the in-process, HTTP, and
Sekiban Cloud transport constructors. The focused guard executes meeting-room
create/reserve through in-process and HTTP transports and compares the exact
serialized V1 request/response envelope bytes, including empty-head
consistency entries.

### AC2 — snapshot-only execution and conflicts

The facade supports snapshot-only execution, performs zero reads in that mode,
fails closed with typed `executor.snapshot_missing` when a required snapshot is
absent, carries returned heads into the next snapshot-only command, and maps
exhausted commit conflicts to the typed conflict result with tag, expected
head, and actual head.

### AC3 — tag-state head semantics

Tag reads map an existing tag to its exact committed head, an existing empty tag
to the exact assert-empty string, and an unclaimed tag to an omitted
consistency entry. `SnapshotReader.head` preserves the exact head rather than
reconstructing it from a materialized state.

### AC4 — cloud credential rejection and scope

The cloud transport sends the required service/credential identity headers,
maps HTTP 401/403 to typed `credential.rejected` without retrying, and
sanitizes credential material from errors/results. The executor rejects a
service-scope mismatch before issuing a command.

### AC7 local preservation

The existing `ClientCommandContext`/claim-ledger path, V1 wire member names,
ordering, and existing G41/G49/G51/G52/G54/G56 protections remain in place.
The sample transport and existing test fakes were extended only to satisfy the
new transport contract; no deployment surface or production admission path
was changed.

## Files and boundaries

The checkpoint adds `packages/dcb-client/src/executor.ts` and
`test/g57-executor.spec.ts`, extends the client transport contract and domain
snapshot head typing, updates the sample transport and two existing test fakes,
and adds the package dependency/lock entry for `@sekiban/dcb-domain`. The
focused C-12 fixture is retained as a tracked red receipt.

The 5,000 ms contract, outbox/Queue/global admission path, projector
advancement, G58 health/coverage/lag/live-poll behavior, SafeWindow, ordering,
fences, trace schema, V2 envelopes, and unrelated code were not changed.

## Local verification

All commands below were run in `.g57-w126` without weakening or inflating a
gate:

| Gate | Result |
| --- | --- |
| `npx vitest run --config vitest.config.ts test/g57-executor.spec.ts` | 5 passed |
| `npm run test:g41` | passed; forced-red and production mutants red |
| `npm run test:g49` | passed; binding/migration/database-lineage mutants red |
| `npm run test:g51` | passed; 4 passed, 29 skipped; journal/native-span mutants red |
| `npm run test:g52` | passed; 18 passed; omission mutants red |
| `npm run test:g53` | passed; 10 passed; scope/control/downstream mutants red |
| `npm run test:g54` | passed; 18 passed; omission and empty-head mutants red |
| `npm run test:g55` | passed; 12 passed; read-visibility mutants red |
| `npm run test:g56` | passed; 3 passed; empty-head omission mutant red |
| `npm run typecheck` | passed, including package builds |
| `npm run lint` | passed with `--max-warnings=0` |
| `git diff --check` | passed |

The branch and implementation checkpoint were pushed before this artifact was
prepared. The deployed AC5/AC6 half, production proof, PR, and worker
completion remain intentionally delegated work.

# SDT-G65 PR #127 local repair — WAKE-130

Task: `SDT-G65-PR127-LOCAL-REPAIR-WAKE-130`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
PR: [#127](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/127)
Branch: `claude/sdt-g65-local-wake-w128`
Starting head: `62c1272a3edc8e1f8833e2af73a910c9a4010f4f`
Pushed repair checkpoint: `f83f9c71cd596be9875d49d520e921a02b16bb5a`

This is the local repair half only. No Wrangler, Cloudflare, deployment,
resource, secret, remote D1/Queue, PR-state, self-approval, or worker-complete
operation was used. The pre-existing generated drift listed at the end remains
unstaged and was not discarded.

## Ruling A — header-only admission indication

The valid V1 JSON body remains byte-identical. `samples/meeting-room/src/transport.ts`
continues to copy response headers, and the internal admission association is
now kept in a `WeakMap` keyed by the returned `ExecuteResult`; it is not an
enumerable result/body field. Both meeting-room workers read that association
only to emit the existing `x-sdt-global-admission` response header. The adapter
test covers `admitted`, `not-admitted`, and `unknown`, asserts the header, and
asserts the unchanged body with no `globalAdmission` member.

## F1 — bounded source-partition obligation

After the SQLite event, outbox obligation, and local receipt are durable, the
SQL append schedules source-partition registration through `waitUntil`. It is
not awaited by the commit response. The registration has three idempotent
attempts, each bounded by the existing `G65_DERIVED_WRITE_BUDGET_MS = 300`
constant, with 25 ms incremental backoff. Failed schema probes and INSERTs are
re-tried as derived work; after exhaustion the durable outbox/Queue path remains
the recovery authority. Rejected schema-probe promises are removed from the
G44 schema cache so a later attempt can re-probe. The D1 `recordDelivery` batch
still atomically upserts source partition, event, membership, and receipt, so
G44 remains fail-closed without a proven source obligation.

The real public SQLite tests cover runtime-D1 unavailable, a never-resolving
source schema probe, and a source-partition INSERT failure. Each returns the
committed response without waiting for the derived failure. The existing real
D1 batch-failure test still proves there are no partial global-admission rows.

## F2 — red-capable production guard

`scripts/g65-admission-guard.mjs` no longer treats every mutant as detected:
the mutant oracle throws only when production wiring rejects the mutant, while
an accepted mutant makes `assertRed` fail the guard. `--pre-change` now reads
the pinned pre-G65 source ref
`68454969e6b9c15bb22e5e57bfd388167477dbfb`, rather than re-reading the current
tree and unconditionally throwing.

Receipts:

- Pre-change red: [`.artifacts/sdt-g65-w130-pre-change-red.json`](.artifacts/sdt-g65-w130-pre-change-red.json), exit 1 as expected.
- Post-change green plus six detected red mutants: [`.artifacts/sdt-g65-w130-green-and-mutants.json`](.artifacts/sdt-g65-w130-green-and-mutants.json).
- The six inherited G60 mutants were not edited and remained green through
  `npm run test:g60:required`.

The real G65 tests retain direct-first and Queue-first shared D1 delivery,
duplicate replay, conflicting identity, atomic failure, and public append
coverage; no private in-memory oracle was added.

## F3 — observed timing provenance

The existing `serialized_dcb_g65_admission_attempts` ledger remains the sole
G65 admission timing source. It correlates service, event, SUID, partition, and
attempt identity; records actual `Date.now()` epoch-millisecond attempt start,
finish, outcome, and `global_completion_observed_at`; and records its clock
origin. The observer is scheduled through `waitUntil` and never decides
admission, acknowledgement, projection, retry, or response. Authored
`dcb_events.Timestamp` and receipt `received_at`/caller timestamps are not used
as completion or visibility timing. Doorbell and synchronous-admission
contributions remain separate; no unsupported deployed latency claim is added
in this local-only checkpoint.

## F4 and G35 boundary

The shared serialized runtime owns durable Tag acceptance, local receipt and
outbox obligation, bounded derived attempts, Queue handoff, and the V1 status /
header contract. The meeting-room sample owns only the public command facade,
header propagation, and domain/UI mapping. Queue ordering, retry, DLQ, G44
fencing, reservation/fence behavior, G58/G62 behavior, the V1 wire, and the
5,000 ms constant are unchanged. `docs/write-path.md` records the corrected
boundary and the ordering: durable append, scheduled bounded source
registration, bounded direct/admission attempts, Queue start, then response.

## Ruling B — G21–G25 forced-red diagnosis

The pinned head already contained the existing required G21–G25 package scripts
and `.github/workflows/ci.yml` steps. They were verified rather than duplicated
or weakened. The durable receipt is
[`.artifacts/sdt-g65-w130-g21-g25-forced-red.json`](.artifacts/sdt-g65-w130-g21-g25-forced-red.json):

| Probe | Normal tests | Exit | Deliberate failure |
| --- | ---: | ---: | --- |
| `SDT_G21_FORCE_FAILURE=1 npm run test:g21:forced-red` | 12 passed | 1 | `SDT-G21 forced-red CI wiring proof` |
| `SDT_G22_FORCE_FAILURE=1 npm run test:g22:forced-red` | 7 passed | 1 | `SDT-G22 forced-red CI wiring proof` |
| `SDT_G23_FORCE_FAILURE=1 npm run test:g23:forced-red` | 27 passed | 1 | `SDT-G23 forced-red CI wiring proof` |
| `SDT_G24_FORCE_FAILURE=1 npm run test:g24:forced-red` | 2 passed | 1 | `SDT-G24 forced-red CI wiring proof` |
| `SDT_G25_FORCE_FAILURE=1 npm run test:g25:forced-red` | 3 passed | 1 | `SDT-G25 forced-red CI wiring proof` |

Thus an exit 0 would remain a failed guard, not green. The prior exact-head
CI classification was checked against its job records: the five forced-red
steps completed as guards; the recorded failure was the unrelated G54
`PT0S` versus `PT0.001S` duration flake. No G21–G25 or G54 gate was changed.

## Local verification

All commands below completed successfully unless explicitly marked
expected-red:

| Gate | Result |
| --- | --- |
| `npx vitest run --config vitest.config.ts test/g65-admission.spec.ts test/meeting-room.spec.ts` | PASS, 15/15 |
| `npm run test:g65` | PASS, 8/8; post-change guard green and six mutants red |
| G21–G25 forced-red probes | PASS as guards; each deliberate command exit 1, above |
| `npm run test:g26` | PASS, 32 tests |
| `npm run test:g29:mapping` | PASS, 92 tests plus contract runner |
| `npm run test:g29:delivery` | PASS, 7 tests plus matrix runner |
| `npm run test:g29:diagnostics` | PASS, 12 tests |
| `npm run test:g29:compatibility` | PASS, 5 tests |
| `npm run test:g41` | PASS, 8 tests; production mutants red |
| `npm run test:g44` | PASS, 8 tests; production mutants red |
| `npm run test:g49` | PASS, binding/migration/lineage mutants red |
| `npm run test:g51` | PASS, 4 selected tests; retained guard runners green |
| `npm run test:g52` | PASS, 18 tests; omission mutants red |
| `npm run test:g53` | PASS, 10 tests; scope/control mutants red |
| `npm run test:g54` | PASS, 18 tests; production omission mutants red |
| `npm run test:g55` | PASS, 12 tests; read-visibility mutations red |
| `npm run test:g56` | PASS, 3 tests; omission mutant red |
| `npm run test:g58` | PASS, 15 tests; existing G58 guards green |
| `npm run test:g60:required` | PASS; direct, Queue, hop, unsafe-writer, and post-admission guards green |
| `npm run test:g61` | PASS; retained-frontier pre-fix red and mutant red |
| `npm run test:g62` | PASS; cursor-aware mutants red |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |

## Boundary and remaining work

The pushed branch contains only the local repair/evidence commit above plus
the final report commit. No deployed remeasurement was performed or claimed;
the next delegation may perform it under its own authorization. PR #127 was
not opened, updated, self-approved, merged, or worker-completed by this task.

The following pre-existing generated files remain intentionally unstaged and
untouched by the repair commit:

```text
.artifacts/sdt-g58-w97-green-guard.json
.artifacts/sdt-g58-w98-lag-red-guard.json
.artifacts/sdt-g58-w111-green-guard.json
.artifacts/sdt-g58-w112-green-guard.json
.artifacts/sdt-g65-w129-healthy-cohort.json
test/fixtures/g61-retained-frontier-green.json
test/fixtures/g61-retained-frontier-mutant-red.json
test/fixtures/g61-retained-frontier-red-before-green.json
test/fixtures/g62-w141-ac1-ac3-green.json
test/fixtures/g62-w141-mutants-red.json
```

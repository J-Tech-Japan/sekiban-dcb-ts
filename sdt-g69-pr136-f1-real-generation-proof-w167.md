# SDT-G69 PR136 F1 real-generation proof — W167

Status: local repair complete; exact-head hosted CI and rereview required.

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: #136
- Branch: `claude/sdt-g69-local-ordering-proof-w164`
- Reviewed starting head: `f8f948647f032e14e191a5a45d173da8f0bb4aa5`
- Review: `5137295711`
- Review artifact: `sdt-g69-pr136-hotpath-exact-rereview-w167.md`
- Scope: F1 proof coverage only. The runtime hot-path repair from W167 remains
  unchanged; no fence, SafeWindow, retry, drain, G67 assertion, deployment,
  production, Cloudflare, resource, G32, review, merge, or closeout action was
  performed.

## F1 repair and proof method

The review finding was that the prior named-clock checks called the detector
with literal checkpoint clocks and did not prove generation application or a
public safe-read result. The added test uses the real local SQLite/D1 path:

1. `D1EventStore.recordDelivery` admits each source event.
2. `MaterializedViewCatchUpRuntime.build`/`follow` applies the real
   `ReservationProjector` generation and durable checkpoint.
3. The detector classification and ordering quarantine are read from durable
   state after the real pass.
4. `handleSerializedQuery` is invoked through the public V1 query boundary,
   with the same D1 materialized-view database, for both `safe` and `unsafe`
   reads.

The clock schedules are deterministic observed-arrival inputs at the real
`recordDelivery` boundary. They are not supplied detector history and are not
claimed as wall-clock production measurements.

## Real generation/public-reader matrix

The focused run exercised all six required cases. Every row asserted the
generation number/checkpoint SUID, detector classification, durable quarantine
presence or absence, and public safe/unsafe status.

| case | real generation/checkpoint assertion | detector classification | durable quarantine | public safe / unsafe |
| --- | --- | --- | --- | --- |
| captured-before-admission | generation 0 remains at the higher-SUID checkpoint | `miss` | absent | 200 / 200 |
| equal-millisecond | generation 0 remains at the higher-SUID checkpoint | `miss` | absent | 200 / 200 |
| checkpoint overwrite | generation 0 advances to the later higher SUID through a second real follow | `miss` | absent | 200 / 200 |
| decreasing replay | generation 0 remains at the higher-SUID checkpoint; replay keeps FirstArrivedAt at its earlier observed value | `replay` | absent | 200 / 200 |
| clock rollback | generation 0 remains at the higher-SUID checkpoint | `unknown` (`arrival-clock-rollback`) | absent | 200 / 200 |
| genuine late-lower control | generation 0 remains at the higher-SUID checkpoint | `late-lower-suid` | open, generation-bound quarantine | typed 503 `projection_ordering_quarantined` / 200 |

The late-lower control is the genuine refusal oracle: a lower-SUID event is
admitted after the higher checkpoint with a later observed arrival, the real
follow persists the ordering incident/quarantine, the public safe reader
returns typed 503, and the explicit unsafe reader remains usable. The other
five cases demonstrate non-quarantine classifications through the real
generation/public-read path.

The normal admission path preserves `FirstArrivedAt` as MIN and
`LastArrivedAt` as MAX, so it cannot create a rollback pair. The rollback case
therefore uses an explicit imported/repair-style SQL clock corruption after a
real generation checkpoint. It proves the alarm-only `unknown`
`arrival-clock-rollback` classification and public availability, but is not a
claim that ordinary production delivery can produce that corruption. This is
the required schedule limitation; no detector checkpoint-clock shortcut is
used.

## Preserved contracts and guards

- The W167 nonblocking diagnostic receipt and once-per-catch-up-pass detector
  query remain intact; diagnostics provide no allocation closure.
- The six SDT-G60 mutants remain unmodified and green.
- G67 AC3's 5,000 ms assertion and timeout remain unchanged.
- G44/G62 frontier certification, SafeWindow, retries, drain behavior and
  unsafe-read behavior are unchanged.
- SDT-G69 AC4/AC5 and issue #133 remain outstanding; this is proof coverage,
  not deployed or production acceptance evidence.

## Verification

Commands run on the scoped worktree before push:

- `npx vitest run test/g69-ordering.spec.ts --pool=forks --maxWorkers=1 --no-file-parallelism --disableConsoleIntercept` — 1 file, 7/7 passed; real-generation matrix passed. Local NOSENTRY alarm/Hyperdrive diagnostics were emitted but did not fail the suite.
- `npm run test:g69` — passed; 4/4 G69 mutants red as expected.
- `npm run test:g67` — passed in the isolated rerun: 11/11 behavior tests and 7/7 mutants red. A prior overlapping local invocation produced five fixture failures while another G67 runner was active; that collision was discarded, and the isolated command is the gate result.
- `npm run test:g44` — passed: 8/8 tests and 4/4 production mutants red.
- `npm run test:g60:required` — passed: 14/14 direct/unsafe/Queue/durable-hop/post-admission tests and all six unchanged G60 mutants red.
- `npm run test:g65` — passed: 17/17 tests and required G65 red/oracle evidence green.
- `npm run typecheck` — passed.
- `npm run lint` — passed with `--max-warnings=0`.
- `git diff --check` — passed.

Known local environment diagnostics (non-gating) were the existing nonempty
Hyperdrive local binding and NOSENTRY SQLite alarm scheduling messages. No
Cloudflare operation was attempted.

The final pushed evidence head and exact-head hosted CI result will be added
to the canonical handoff after the scoped commit and push. No deployed cohort
was run.

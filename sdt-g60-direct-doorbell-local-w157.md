# SDT-G60 direct doorbell local checkpoint — W157

Task: `SDT-G60-DIRECT-DOORBELL-LOCAL-W157`

Issue: SDT-G60 / #113

Branch: `claude/sdt-g60-clean-preg53-ab-w124`

Starting W156 head: `2274cbe0c648a6996d711081c15e7ad30fff51a4`
Pushed local repair checkpoint: `84892e5bd5233de9c12f07dffb12b28e08bee00e`

## Bounded result

This is the local half of WAKE-122 lever two. The commit-time direct unsafe
delivery path is implemented and its local red-capable guards are green. No
Wrangler or remote Cloudflare deployment, secret, D1, Queue, cohort, PR, or
issue-transition operation was performed. Local D1/Queue test fixtures were
used only by the requested local gates. The only remote operation was the
requested Git branch push.

Lever one remains settled negative and was not repeated: W156's isolated
configuration measurement with `max_batch_size=1` and `max_batch_timeout=1`
reported `n=10`, `p50=4,958 ms`, `p95=23,927 ms`, and `5/10` strictly over the
unchanged 5,000 ms contract. Local Wrangler schema inspection found no
supported producer-side lone-message immediate-dispatch setting; the
producer's `delivery_delay` is a delay and was not used as an optimization.

## Local repair and invariants

Both SQL and SQL-less transport-seam append paths now perform the following
sequence after the durable append result has completed:

1. Build the response object only after the Tag event, outbox obligation, and
   local commit receipt have been persisted.
2. When the existing direct-doorbell preflight is ready, claim the pending
   durable outbox rows and await the existing `DOWNSTREAM_DOORBELL.deliver`
   seam before returning the 201 response. The direct receiver is the existing
   `deliverMeetingRoomDoorbell` path; no new admission or view implementation
   was added.
3. Retain a Queue-only drain promise with `ctx.waitUntil`, passing the exact
   already-claimed envelope rows. This prevents a second direct invocation and
   preserves the existing Queue send order, global-admission path, retry and
   DLQ ownership. The direct path never marks a source obligation delivered.

If pending-row preparation or the direct attempt fails, the durable acceptance
is retained and the existing Queue drain is used as the backstop. Alarm-driven
drains without preclaimed rows retain their existing per-row direct-then-Queue
ordering. `DeliveryCore`, `processDownstreamDoorbell`, G44 completeness, the
safe lane, G58/G62 maintenance, reservation/fence behavior, SafeWindow, and
the 5,000 ms constant were not changed.

The existing `active.lastSuid`/upsert semantics remain the idempotency
authority. The real G26 integration now records and asserts
`direct-start -> direct-end -> response-returned`, sends the byte-identical
envelope through Queue, replays it, and verifies no duplicate MV apply or
lower-SUID regression.

Implementation locations:

- [`TagDurableObject.ts`](packages/dcb-runtime/src/tag/TagDurableObject.ts:2863)
  performs direct delivery after durable response construction in both append
  implementations; the direct helper is at line 3022 and the Queue-only
  preclaimed handoff is at line 3054.
- [`g26-integration.spec.ts`](test/g26-integration.spec.ts:216) is the real
  Tag/outbox/direct/Queue lifecycle oracle.
- [`g60-direct-doorbell-guard.mjs`](scripts/g60-direct-doorbell-guard.mjs:1)
  is the W157 focused red-capable guard.
- [`package.json`](package.json:127) exposes `test:g60:direct` for the local
  G60 lane.

## Red-before-green and mutant evidence

The pre-change guard ran against the exact W156 source before the product edit:

```text
node scripts/g60-direct-doorbell-guard.mjs --pre-change --receipt .artifacts/sdt-g60-w157-direct-doorbell-red.json
```

It intentionally exited `1` with the required red receipt:
`direct commit-time handoff is absent: directDeliveryBeforeResponse`.

The focused post-change guard and self-test are green. The green receipt names
all required red mutants:

- direct-delivery omission;
- old Queue-dependent behavior;
- response-before-direct completion;
- direct attempt reordered before durable event/outbox/local receipt;
- duplicate later Queue replay;
- lower-SUID later Queue replay regression.

The existing W144 queue handoff guard also remains green, including its
append-path omission and old waitUntil-only mutants. Existing G60 unsafe-writer
and post-admission guards remain green, including independent unsafe apply on
`BLOCK/UNSETTLED` and the scheduled safe-drain distinction.

| receipt | SHA-256 |
|---|---|
| [W157 pre-change red](.artifacts/sdt-g60-w157-direct-doorbell-red.json) | `448467b2dc03dde1093abb566dd326336851bb6fadd341050f79df07e630b359` |
| [W157 self-test](.artifacts/sdt-g60-w157-direct-doorbell-self-test.json) | `cf13fd79c0049866cfd928efd45abc1466f51ef4341e008246d119adeb309375` |
| [W157 direct green](.artifacts/sdt-g60-w157-direct-doorbell-green.json) | `97fbdb30dd562130ecd6256996e810b9f828187036cc18800acd47a5afc1b930` |
| [W157 Queue regression green](.artifacts/sdt-g60-w157-queue-regression-green.json) | `7dd7b4d275b4bb3dc1337ab145dda4b66e17a0d902450e2296730f264b5530de` |

## Verification

All commands below were local-only and completed successfully. No gate was
weakened, skipped, or timeout-inflated.

| command | result |
|---|---|
| `npm run test:g60:direct` | 3 files, 14/14 tests passed; W157 self-test and guard green |
| `npm run test:g60:queue` | W144 queue handoff guard green; omission and old waitUntil mutants red |
| `npm run test:g60:unsafe-writer` | 2 files, 4/4 tests passed; unsafe-writer guard green |
| `node scripts/g60-durable-hop-guard.mjs --self-test && node scripts/g60-durable-hop-guard.mjs` | durable seven-hop guard green |
| `node scripts/g60-post-admission-guard.mjs --self-test && node scripts/g60-post-admission-guard.mjs` | post-admission guard green; omission/reorder mutants red |
| `npm run test:g26` | 4 files, 32/32 tests passed |
| `npm run test:g29:delivery` | 7/7 tests passed; delivery matrix passed |
| `npm run test:g29:mapping` | 92/92 tests passed; mapping runner passed |
| `npm run test:g29:diagnostics` | 12/12 tests passed |
| `npm run test:g29:compatibility` | 5/5 tests passed |
| `npm run test:g29:sample` | 2 files, 14/14 tests passed |
| `npm run test:g41` | 8/8 tests passed; contract and production mutants passed |
| `npm run test:g44` | 8/8 tests passed; unchanged G44 fence and atomic mutants passed |
| `npm run test:g53` | 10/10 tests passed; scope and downstream mutants passed |
| `npm run test:g55` | 4 files, 12/12 tests passed; read-visibility guard passed |
| `npm run test:g58` | 5 files, 15/15 tests passed; existing G58 guards/mutants passed |
| `npm run test:g62` | G62 anchors and AC1–AC3 guard green; required mutants red |
| `npm run test:d1` | 12/12 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `git diff --check` | pass |

## Evidence hygiene and boundaries

The starting worktree already contained unrelated dirty G58/G61/G62 generated
receipts and untracked W128/W137/W143/W151–W156 reports/scripts/evidence. They
were preserved, never reverted, and never staged. Only the nine W157 repair,
guard, test, package-script, and receipt paths were included in commit
`84892e5`. Generated package `dist/` output remains ignored.

The W156 W155 arm, production Worker/resources, and all W130 arms remain
untouched. This checkpoint contains no deployed measurement and does not claim
AC3 completion. The next authorized window must deploy the exact pushed W157
source to the approved fresh/isolated arm, clean only that arm's operational
data, and run one cold-first paced cohort of at least ten samples. It must
verify exact source/version/bindings, persist the seven-hop and writer-boundary
ledger, demonstrate unsafe visibility during completeness BLOCK, calculate
per-hop and total timing, and evaluate every sample against the unchanged
5,000 ms contract. Only after that deployed proof can G60 decide whether its
remaining acceptance evidence is complete; no PR or worker-completion
transition was performed here.

The next-window retry policy is carried verbatim:

> with the five credential variables stripped, D1 code 7403 on READ or idempotent operations may be retried up to three times with backoffs approximately 5/20/60 seconds; D1 code 7403 on non-idempotent writes may be retried once only after 60 seconds; record every attempt timestamp/outcome; stop after exhaustion. Any other error retains the WAKE-108 one-classifier rule.

G56 remains held; no downstream unit was started.

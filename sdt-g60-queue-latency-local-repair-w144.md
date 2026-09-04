# SDT-G60 queue-latency local repair (W144)

Task: `SDT-G60-QUEUE-LATENCY-LOCAL-REPAIR-W144`

Issue: SDT-G60 / #113

Branch: `claude/sdt-g60-clean-preg53-ab-w124`

Starting head: `4488fd3eea863c96383e5d1a2d2abc99a71c40c8`

Repair checkpoint: `9eabe0458c59b89a96af56738063a94c6934a0ee`
Recorded: 2026-09-04

## Bounded scope

This checkpoint implements only the local AC2/AC4 queue-handoff lever authorized
by the W144 delegation. No Wrangler command, Cloudflare read/write, deployment,
resource creation, cohort, PR, or AC3 completion claim was made. The production
Worker and all prior W130/W131 resources remain untouched.

The unchanged contract and boundaries remain in force: the 5,000 ms constant,
SafeWindow, durable Tag event/outbox obligation/receipt ordering, retry and
failure recovery, reservation/fence protocol, G53 naming, G55 reads, G58
surfaces, the Tag outbox and Queue configuration, and global-D1 admission were
not weakened or changed. Projector-head convergence remains outside G60.

## Observed cause from W143

W143's one fresh stripped-environment cohort recorded the dominant observed
interval before the W127 post-admission spans:

- cohort: 10 samples; cold first sample censored at the fixed observation
  ceiling; 9 observed; observed p50 `4,681 ms`, p95 `9,286 ms`; strict
  `>5,000 ms` count `4/10` and over-or-missing count `5/10`;
- Queue send returned -> consumer invocation started values, in ordinal sample
  order: `5,954, 4,724, 8,831, 9,175, 7,533, 7,186, 2,579, 2,743, 2,033,
  3,671 ms`;
- the four strict over-bound samples were samples 3, 4, 5, and 6, with Queue
  send -> consumer-start values `8,831`, `9,175`, `7,533`, and `7,186 ms`;
- every completed W127 post-admission span was at most `495 ms`; the cold
  sample stopped at `completeness-coverage=BLOCK/UNSETTLED` and had no completed
  detector/view sub-hops.

The source at the starting head invoked `autoDrainAfterResponse` only through
`ctx.waitUntil`. That helper first awaited `setTimeout(resolve, 0)` and only
then began `autoDrainOutbox`. Consequently the first pending-outbox read and
Queue send were scheduled after the append response boundary. This matches the
measured pre-admission Queue/consumer interval; it does not identify or repair
the upstream Queue/global-admission cause owned by G60's later measurement
work.

## Local repair

After `appendSql` or the fallback storage transaction has returned a successful
durable result, both append paths now call
`startAutoDrainBeforeResponse(tag, serviceId, domainDeliveryClass)` before
returning the 201 response. The helper:

1. calls `autoDrainOutbox` immediately, so its pending-outbox read and the
   subsequent Queue submission are started before/concurrently with the
   response clock;
2. attaches the already-started promise to `ctx.waitUntil`, retaining Worker
   lifetime without awaiting transport backpressure as a response dependency;
3. preserves the existing outer `.catch(() => undefined)` behavior and all
   per-row Queue failure/retry handling.

The durable event, obligation, and receipt are still committed before this
helper is reachable. The helper does not mark delivery or apply a view, and the
alarm drain path is unchanged. The source guard verifies both SQL and fallback
append paths, the response-return ordering, and that the old zero-delay helper
is absent.

Changed files:

- `packages/dcb-runtime/src/tag/TagDurableObject.ts`: replace the two
  response-only timer handoffs with the pre-response-start helper;
- `test/g26-doorbell.spec.ts`: retain the complete envelope, response, and
  eventual doorbell/Queue assertions while removing the obsolete assertion
  that transport calls must remain empty after the response;
- `scripts/g60-queue-latency-guard.mjs`: source/order guard with pre-change,
  omission, and old-waitUntil mutant receipts;
- `package.json`: add the focused `test:g60:queue` guard command.

## Red-before-green evidence

The pre-change guard was run against the exact starting `HEAD` source with:

```text
node scripts/g60-queue-latency-guard.mjs --pre-change --receipt .artifacts/sdt-g60-w144-queue-latency-red.json
```

It intentionally exited `1` and wrote [the red receipt](.artifacts/sdt-g60-w144-queue-latency-red.json):
`old waitUntil-only zero-delay handoff remains`. The self-test also records the
legacy fixture as red before the current path is checked green.

The focused post-change command was:

```text
npm run test:g60:queue
```

It passed. [The green receipt](.artifacts/sdt-g60-w144-queue-latency-green.json)
records `appendDrainStarts=2`, `appendResponseReturns=2`, and
`waitUntilRetainsStartedPromise=true`. Both required mutants are red:

- omission of one append-path helper call: red because only one of two paths
  starts the drain;
- replacement with the old `waitUntil(autoDrainAfterResponse(...))`: red
  because the old zero-delay handoff marker remains.

The [self-test receipt](.artifacts/sdt-g60-w144-queue-latency-self-test.json)
also records the old waitUntil-only fixture as an expected red result.

## Verification

All commands below completed successfully without Wrangler or remote resources:

| command | result |
|---|---|
| `npx vitest run --config vitest.config.ts test/g26-doorbell.spec.ts test/g26-integration.spec.ts` | 2 files, 14/14 tests passed |
| `npm run test:g60:queue` | focused green guard; both red mutants passed |
| `npm run test:g41` | pass; 8/8 focused tests and mutation/contract checks |
| `npm run test:g44` | pass; 8/8 tests and atomic mutation checks |
| `npm run test:g49` | binding parity pass; omission/migration/lineage mutants red |
| `npm run test:g51` | pass; selected tests 4 passed, 29 skipped by the existing pattern, all listed guards passed |
| `npm run test:g52` | 4 files, 18/18 tests passed; omission mutants red |
| `npm run test:g53` | 1 file, 10/10 tests passed; control/downstream mutants red |
| `npm run test:g54` | 3 files, 18/18 tests passed; production and known-divergence mutants red |
| `npm run test:g55` | 4 files, 12/12 tests passed; read-visibility guard passed |
| `npm run test:g58` | 5 files, 14/14 tests passed; existing G58 guards and mutants passed |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `git diff --check` | pass |

The unchanged G44 fence behavior remains green. No gate was skipped, weakened,
or timeout-inflated.

## Incidental dirty/generated drift

At W144 start the worktree already contained four dirty tracked generated G58
receipts: `.artifacts/sdt-g58-w111-green-guard.json`,
`.artifacts/sdt-g58-w112-green-guard.json`,
`.artifacts/sdt-g58-w97-green-guard.json`, and
`.artifacts/sdt-g58-w98-lag-red-guard.json`. The G58 verification also runs
receipt-producing guards. These files are unrelated to W144 and were not
reverted or staged. Older untracked W128/W137/W143 scripts, reports, and raw
evidence were likewise preserved and excluded. Only the W144 guard receipts
and W144 source/test/package changes are in the repair commit.

## Checkpoint status and next boundary

The local repair is committed at
`9eabe0458c59b89a96af56738063a94c6934a0ee`; this report is the evidence
follow-up on the same branch and both commits are pushed together. This is a
checkpoint only: the next authorized step is a separate deployed
measurement of whether moving drain start reduces the Queue-send-to-consumer
interval. W144 intentionally does not select a further lever, deploy, run a
cohort, open a PR, or claim AC3 completion.

# SDT-G65 RING/APPLY local checkpoint (WAKE-139)

Task: `SDT-G65-RING-APPLY-LOCAL-WAKE-139`
Branch: `claude/sdt-g65-local-wake-w128`
Starting head: `8866322a465738cfa3c4253afe3a0f5b7baf2937`
Scope: local implementation and evidence only. No Wrangler, Cloudflare, deployment,
resource, PR-state, merge, review-state, or worker-completion operation was run.

## Binding AC0

The amended AC0 supplied by orchestration is binding and is carried unchanged:

> AC0 (bound the existing direct doorbell first, same rule as the rest of this
> unit; latency clause corrected 2026-09-05): the SDT-G60 direct delivery before
> the response (`TagDurableObject.directDeliveryBeforeResponse ->
> deliverDirectRows -> DOWNSTREAM_DOORBELL.deliver`) runs under a bounded time
> budget - a documented constant on the order of a few hundred milliseconds -
> after which the commit response is returned regardless, with the unsafe apply
> left to the Queue path exactly as on a direct failure today; a hang is treated
> as an unknown outcome for the derived write, never for the commit. The six
> SDT-G60 mutants stay green and unmodified, and a new red-capable guard proves
> a doorbell receiver that never resolves cannot delay the commit response beyond
> the budget. Unsafe visibility stays within the 5,000 ms contract on the
> deployed cohort. LATENCY RULE, relative to the same arm and never to a figure
> measured elsewhere: the absolute 1,308 ms target is WITHDRAWN (it was the
> SDT-G52 production-worker LAX figure, n=50, a different worker and colo); the
> governing baseline is the fresh pre-change cohort on the same arm in the same
> window (n>=10, cold first sample). Post-change client send-to-response p95 must
> be within 150 ms of that baseline p95, and the p50 increase must not exceed the
> AC1 synchronous-admission budget plus 100 ms, because admission-before-response
> is deliberately added work. The evidence must account for the two contributions
> separately where the instrumentation allows: the doorbell bound may only reduce
> or hold latency, and the synchronous admission attempt is the only permitted
> addition. The W128 measurement - baseline p50/p95 2,145/2,417 ms, post-change
> 2,413/2,545 ms, admission attempt p50 338 ms, 0 of 10 over 5,000 ms unsafe,
> 10 of 10 responses with no 504 - satisfies this rule. MECHANISM RULING
> (2026-09-05, after W138 showed all 20 unsafe-writer rows on transport=queue
> with the binding verified): a fixed budget in front of the EXISTING doorbell
> cannot work, because the existing doorbell awaits the receiver's full D1 apply,
> which SDT-G60 measured at roughly 2.5 s per commit; any budget small enough to
> protect the response will always expire and always fall back to the Queue, which
> is exactly what W138 observed. The direct path must therefore be split into
> RING and APPLY: the commit path awaits only the ring - a lightweight signal to
> the receiver that returns as soon as the receiver has durably accepted the
> obligation, budgeted at about 100 ms - and the receiver performs the D1 unsafe
> apply immediately but asynchronously (its own waitUntil, alarm or equivalent),
> independent of the caller's response. The response therefore never waits for a
> D1 write, while unsafe visibility stays at the receiver's apply latency (target:
> unchanged from SDT-G60's 189 ms p50 response-to-visible). The Queue path remains
> the guarantee and the receiver apply remains idempotent so the later Queue
> delivery is a no-op. The evidence must record, per commit, the ring outcome
> (rung within budget / budget expired / failed) and the apply outcome and its
> timing, so a Queue fallback is visible as such and never silently counted as
> direct. A cohort in which every row shows transport=queue is a failed cohort for
> AC0, not a pass with slow numbers.

## Implementation

The scoped checkpoint adds:

- `migrations/d1/g32/0010_g65_direct_rings.sql`, an append-only, stable
  service/event/SUID/attempt ledger with ring start/finish/outcome and apply
  start/finish/outcome/error columns.
- `packages/dcb-runtime/src/diagnostics/G65DirectRing.ts`, exporting the
  documented `G65_DIRECT_RING_BUDGET_MS = 100` constant and durable ring/apply
  ledger operations. Ring identity is `INSERT OR IGNORE`; a replay is reported
  as `duplicate` and cannot create a second obligation.
- The deployed-D1 receiver path in
  `samples/meeting-room/src/worker.cloudflare-receiver-support.ts` now awaits
  only the durable ring. It schedules the existing apply core through
  `ctx.waitUntil`; it does not await the receiver's D1 unsafe apply. A receiver
  without D1 retains the pre-existing local fixture fallback and does not claim
  a durable ring.
- The existing Queue producer/consumer, outbox obligation, local receipt,
  global admission, ordering, retries, DLQ behavior, safe completeness fence,
  reservation/fence protocol, G58/G62 maintenance, V1 wire, and 5,000 ms
  contract are unchanged. The existing six G60 guards remain untouched.
- D1 migration inventory and the local G44 migration helper include the new
  table. `docs/write-path.md` documents RING/APPLY, its clock origin (`Date.now`
  epoch milliseconds), the 100 ms budget, Queue fallback, idempotence, and the
  Queue/DLQ configuration check.

The existing G65 public admission tests remain in the required lane. They prove
the configured first-partition failure/hang is serialized as bounded typed
`partition_registration_unavailable` with no authoritative event, that a
registered partition does not await D1 and reports not-admitted when admission
is unavailable, and that repeat registration is idempotent and non-blocking.

## Red-before-green evidence

| Guard | Receipt/command | Result |
|---|---|---|
| New ring guard before the change | `node scripts/g65-ring-apply-guard.mjs --pre-change --receipt .artifacts/sdt-g65-w139-ring-apply-pre-change.json` | Exit 1 as required: the pinned pre-change receiver has no durable ring wiring. |
| New ring guard current source | `node scripts/g65-ring-apply-guard.mjs --self-test --receipt .artifacts/sdt-g65-w139-ring-apply-guard.json` | Green; ring wiring, durable ledger, async apply, and the awaited-apply mutant are all checked. |
| New receiver behavior | `npx vitest run --config vitest.config.ts test/g65-ring-apply.spec.ts` | 1 file/1 test green. The receiver returns after ring while a held apply is incomplete; releasing the execution context produces the applied ledger outcome. |
| Awaited-apply mutant | Included by the new guard | Red as required: replacing `ctx.waitUntil(apply.catch(...))` with awaited apply violates the ring/response contract. |
| Existing G65 admission/idempotence guards | `npm run test:g65` | 2 files/16 tests green; existing admission red/mutation receipts remain green and the new ring guard is green. |
| Existing six G60 guards | `npm run test:g60:required` | Green; omission, old waitUntil-only, durability ordering, duplicate replay, regression, unsafe-writer, post-admission, and durable-hop mutants remain red-capable. |

The raw new guard receipts remain in the ignored evidence directory at the paths
shown above; their compact red/green outcomes are reproduced here so the pushed
checkpoint does not depend on an expanded generated artifact.

## Queue/DLQ configuration diagnosis

This was read-only local inspection; no Wrangler or Cloudflare call was made.
The retained `.artifacts/wrangler.g65-w155-c.jsonc` arm config uses the existing
`DOWNSTREAM_QUEUE` producer, `max_batch_timeout: 1`, `max_retries: 3`, the
existing `sekiban-dcb-g60-w155-c-outbox-dlq`, and the existing
`DOWNSTREAM_DOORBELL` receiver binding. The canonical production-shaped config
is `samples/meeting-room/wrangler.cloudflare-only.jsonc`; its migration root is
`../../migrations/d1/g32`. This identifies the later deployed Queue/DLQ check
path without mutating that arm.

## Local gates

The directly affected and regression lanes that completed green were:

- `npm run build:packages`, `npm run typecheck`, `npm run lint`,
  `git diff --check`.
- `npm run test:d1` (12 tests), `npm run test:g26` (4 files/32 tests),
  `npm run test:g44` (8 tests plus all G44 production mutants red),
  `npm run test:g60:required`, and `npm run test:g65` (16 tests plus all
  admission/ring mutants red).
- G21, G22, G23, G24, G25, G27, G28 and all G28 boundary sub-gates, G29
  mapping/delivery/diagnostics/compatibility/domain-source/authoring-doc/
  sample/witness/candidate, G31, G37 evidence, G38 prep, G42, G43, G45,
  G46, G49, G51, G52, G53, G54, G55, G56, G58, G61, G62, G26 topology,
  G31 candidate, G32 candidate, store-contract, MV, consumer, G17 and
  rollout-order all exited 0.

The full aggregate `npm run check` was not claimed green:

1. Its first attempt stopped at G28 package packing because the sandbox could
   not write `/Users/tomohisa/.npm/_logs`. Re-running the same gate with
   `npm_config_cache=/tmp/sdt-g65-w139-npm-cache` passed all source,
   negative-fixture, and package-manifest checks.
2. The aggregate parallel `npm test` run had three unrelated order/teardown
   failures: G43 AC6 at `test/g43-tag-sql.spec.ts:443` received the earlier
   `g43-attempt-insert-1` obligation instead of event
   `0ecb1824-ac84-78df-9698-d91b9abfdcfe`; `test/commit.spec.ts:556` AC7
   timed out at the existing 5,000 ms limit; and `test/tag.spec.ts:401` G5
   timed out at that same limit. The exact G43 test, commit AC7 test, and Tag
   G5 test each passed in isolated Vitest invocations. No fixture, timeout, or
   scheduler expectation was changed.
3. `npm run test:g32` passed its 10-file/50-test phase and emitted the complete
   14-row SUID production-mutant-red matrix, then produced no further output.
   The process was stopped at exit 130 after the bounded local timebox. The
   next isolated command, `node scripts/g32-payload-admission-mutation-runner.mjs`,
   exited 1 on its precondition because preserved pre-existing dirty
   `packages/dcb-runtime/src/commit/CommitWorker.ts` removes
   `TextDecoder(..., { fatal: true })`; the non-UTF-8 fixture consequently
   returned HTTP 500 instead of 400. That file was not staged or modified by
   this checkpoint. The G32 exception is therefore recorded, not hidden or
   weakened.

No lane was left running after the G32 process was stopped. The existing
unrelated dirty artifacts, including the CommitWorker diff and prior generated
receipts, were preserved and not staged.

## Boundary and next step

This is a local RING/APPLY checkpoint only. It does not claim deployed AC0/AC5
or the same-arm cold-first cohort, and it does not open or alter PR/review
state. A later deployed continuation must verify a real receiver binding,
per-commit ring/apply outcomes, unsafe visibility under 5,000 ms, Queue replay
idempotence, and the amended same-arm latency rules.

The scoped implementation and this artifact are pushed on the existing PR
branch. The checkpoint is reportable as **blocked only by the preserved,
unrelated local aggregate/G32 runner conditions above**; no product blocker was
found in the RING/APPLY path.

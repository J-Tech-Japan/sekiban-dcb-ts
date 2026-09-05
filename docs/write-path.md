# Serialized write-path contract

This document records the SDT-G65 local contract for a successful serialized
commit. It describes the response boundary and the two derived delivery lanes;
it does not change the V1 JSON envelope, the Tag event format, the Queue
contract, or the G44 safe-lane fence.

## Durable acceptance and derived work

The Tag Durable Object first commits the event, its outbox obligation, and the
local receipt in the same durable mutation. Only after that commit may derived
work start. The commit response is therefore an acknowledgement of durable
acceptance, not proof that every downstream view is already visible.

The existing direct unsafe doorbell remains the low-latency lane. SDT-G65 bounds
the direct attempt with the named `G65_DERIVED_WRITE_BUDGET_MS = 300` constant.
If the receiver throws or does not resolve before the budget, the response is
returned and the unchanged durable Queue fallback is retained. The late direct
operation is an unknown outcome for the derived write only; it cannot turn a
durable commit into a failure and it cannot delay the commit indefinitely. The
Queue continues to own durable global admission, ordering, retries, and DLQ
recovery.

The same source envelope is also admitted through the shared
`D1EventStore.recordDelivery(..., "fast")` path before the response when the
normal D1 binding is available. This attempt has the same 300 ms derived-write
budget. The internal Tag-to-commit response carries
`x-sdt-global-admission` with `admitted`, `not-admitted`, or `unknown`; the V1
JSON body is unchanged. A failed or timed-out admission does not remove the
outbox or Queue fallback. Later Queue delivery is idempotent for the exact
identity and rejects a conflicting payload rather than creating a second global
event.

The two derived attempts are response-bounded, not a platform guarantee that
D1 or a receiver is healthy. Their status is diagnostic/operational state. The
durable event and outbox remain the recovery authority, so a crash after the
response or a partial downstream fan-out is recovered by the existing Queue
path and existing idempotent delivery logic.

Source-partition discoverability has the same failure boundary as global
admission. A successful `recordDelivery` D1 batch upserts the source partition
alongside the global event, membership, and receipt. The old append-time D1
probe/insert is only a post-commit, non-blocking registration attempt. If D1 is
missing, fails, or hangs, the local SQLite commit still returns; until the
atomic global batch (or a later retry) succeeds, there is no source authority
for G44 to certify and the safe lane remains fail-closed.

## Ordering and safety invariants

The required order is:

1. durable Tag event, outbox obligation, and local receipt;
2. bounded direct unsafe attempt and bounded shared D1 admission attempt;
3. the Queue drain is started before the handler returns, but its send,
   acknowledgement, retry, and DLQ work is not awaited by the response;
4. commit response;
5. later Queue acknowledgement/retry remains the recovery path.

The direct unsafe lane never advances a safe checkpoint. G44 completeness
coverage and the SAFE fence remain unchanged: a missing or unproven source
partition cannot be certified merely because a direct unsafe view was applied.
`lastSuid`/upsert idempotence means a duplicate direct/Queue delivery is a
no-op and a later lower SUID cannot regress a materialized row.

## Caller-visible admission outcome and ownership boundary

The meeting-room public command route exposes the actual derived-admission
outcome in the additive `x-sdt-global-admission` response header. Its values
are `admitted`, `not-admitted`, or `unknown`; the V1 JSON body is unchanged and
does not treat the header as a durable commit acknowledgement. The header is
propagated by the V1 adapter from the runtime response, so healthy and
runtime-D1-unavailable cohorts can record the outcome without inventing it from
an authored event timestamp.

The G35 write-path boundary is explicit: the shared serialized runtime owns
the durable Tag event, local outbox/receipt, bounded derived attempts, Queue
handoff, and V1-compatible status/header; the meeting-room sample owns only
the public command facade, header propagation, and its domain/UI mapping.
Cloudflare D1/Queue delivery timing and provider retry/DLQ behavior remain
operational observations, not promises authored by the sample facade.

All admission ledger timestamps use `Date.now()` epoch milliseconds captured at
the actual attempt boundary. `received_at` in
`serialized_dcb_global_receipts` and `Timestamp` in `dcb_events` are
authored/arrival fields, not completion observations, and are not used as
global-visibility timing.

## Measured context carried into G65

These are the measurements that motivate the local contract, preserved from the
SDT-G60 packet and evidence; they are not a new deployed G65 result:

| Path or measurement | n | p50 | p95 | over 5,000 ms |
| --- | ---: | ---: | ---: | ---: |
| SDT-G60 direct doorbell | — | 189 ms | 337 ms | 0 |
| SDT-G60 Queue delivery | — | 1.4–2.7 s | tens of seconds observed | observed long tail |
| SDT-G60 safe visibility | — | 42–95 s | — | not the unsafe contract |
| G52 snapshot-root baseline | 1 | ~520 ms | — | — |
| pre-G60 client response | — | 1,308 ms | — | — |

The G60 values are historical observations, not an assertion that the local
half has deployed them. AC5/AC6 must remeasure the deployed arm, including the
unchanged 5,000 ms unsafe-visible contract and the client-response target.

## Required failure classes and test evidence

The local guard and focused test cover these classes:

- a never-resolving doorbell cannot hold the response beyond the 300 ms direct
  budget plus ordinary scheduling tolerance;
- omission of the synchronous admission attempt is red;
- restoring an unbounded direct wait is red;
- gating the response on a hanging D1 admission is red;
- attempting derived work before durable event/outbox/receipt is red;
- direct-first and Queue-first delivery admit one identity once, while a
  conflicting replay is rejected;
- the existing six SDT-G60 mutants remain separate, unchanged, and green.

The response-independence decision is a durable-acceptance contract chosen by
SDT-G65. It is not a claim that D1, the receiver, or the platform will always
finish within the budget. Crash, duplicate, partial-fanout, D1-outage, and
sustained-write cases must retain the durable outbox/Queue recovery path and
must not weaken ordering, reservation/fence, or G44 proof obligations.

# Serialized write-path contract

This document records the SDT-G65 local contract for a successful serialized
commit. It describes the response boundary and the two derived delivery lanes;
it does not change the V1 JSON envelope, the Tag event format, the Queue
contract, or the G44 safe-lane fence.

For caller-facing result meanings and repair actions, see the [result and
repair matrix](architecture.md#result-and-repair-matrix).

## Durable acceptance and derived work

For an accepted append, the Tag Durable Object commits the event, its outbox
obligation, and the local receipt in the same durable mutation. A composition
without a configured G44 completeness store keeps the pre-G65 local-append
path: no registration probe, wait, or refusal is introduced. The only
pre-append exception for a composition that does configure that store is the
new-partition registration described below; once that bounded authority check
succeeds, all derived delivery work starts only after the local durable
mutation. The commit response is therefore an acknowledgement of durable
acceptance, not proof that every downstream view is already visible.

The existing direct unsafe doorbell is split into a receiver RING and an
asynchronous receiver APPLY. The Tag Durable Object still starts the handoff
only after the event, outbox obligation, and local receipt are durable. The
receiver first persists the exact immutable envelope in
`serialized_dcb_g65_direct_rings` and returns a ring result under the named
`G65_DIRECT_RING_BUDGET_MS = 100` constant. The receiver then reads those
retained bytes in its own execution context and runs the existing
`processDownstreamDoorbell`/idempotent unsafe-view apply through `waitUntil`.
The ring ledger records ring start/finish/outcome and apply start/finish/outcome
for the stable service/event/SUID/attempt identity. The commit path never
awaits the receiver's D1 unsafe apply. If the ring throws or its budget expires,
the response remains a durable acceptance and the unchanged Queue fallback is
retained; the derived ring outcome is degraded/unknown rather than a commit
failure. The Queue continues to own durable global admission, ordering,
retries, and DLQ recovery, and later Queue delivery is a no-op for an already
applied identity.

The G65 APPLY ledger is intentionally narrower than the shared delivery
disposition. `processDownstreamDoorbell` runs independent-unsafe views before
the G44 completeness gate; a later `BLOCK`/`UNSETTLED` coverage result,
detector result, or other full-core failure remains fail-closed for the
ordinary/safe lane and remains visible in `DeliveryCoreResult.failures`, but
does not turn an already `applied` or `duplicate-race` unsafe view into a
failed direct APPLY. The receiver records selected unsafe-view statuses in the
RING/APPLY ledger and records each full-core failure with its phase, class,
view identity, and error text. This preserves the Queue fallback and G44
fence while making direct-writer evidence truthful.

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

Source-partition discoverability has one explicit first-write carve-out. Only
when a composition has a configured G44 completeness store, and only before
the first durable append on a brand-new `(serviceId, tag)` partition, the Tag
Durable Object runs `registerSourcePartition` under the same documented 300 ms
derived-write budget. This is the only derived write allowed to gate a commit
response, because the G44 completeness domain cannot safely certify a source it
has never been told about. If that configured-store registration fails, throws,
or hangs, the append returns HTTP 503 with code
`partition_registration_unavailable` and `retryable: true`; no Tag event,
outbox obligation, or local receipt is written, and the caller must retry. It
is never represented as the 504 `unknown_outcome` admission result. A missing
D1 binding or a D1 binding without the G44 global-array schema is explicitly
unconfigured and therefore does not enter this refusal path.

After the local durable registration marker is established, every later append
on that partition treats registration as an idempotent no-op and never awaits or
consults D1 for that fact. Therefore a registered-tag commit succeeds even when
the runtime D1 binding is entirely unavailable; its durable local response has
the unchanged V1 body and reports `x-sdt-global-admission: not-admitted` when
the bounded shared admission attempt cannot run. The existing outbox obligation
and Queue remain the recovery path, and Queue delivery later advances the
registered partition's obligation sequence through the shared
`recordDelivery` transaction. G44 still requires the global source registry,
membership, receipt, and completeness proof; this carve-out does not weaken or
substitute that fence.

## Ordering and safety invariants

The required order is:

1. for a configured G44 completeness store and a brand-new partition only,
   bounded source registration before the first durable append; refusal writes
   no local event; an unconfigured composition follows the ordinary local
   append path;
2. durable Tag event, outbox obligation, and local receipt;
3. bounded durable receiver ring (100 ms) for the direct unsafe lane, with the
   receiver's D1 APPLY scheduled asynchronously, plus the existing bounded
   shared D1 admission attempt for an accepted append;
4. the Queue drain is started before the handler returns, but its send,
   acknowledgement, retry, and DLQ work is not awaited by the response;
5. commit response;
6. later Queue acknowledgement/retry remains the recovery path.

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

## Required failure classes and test evidence

The local guard and focused test cover these classes:

- a never-resolving receiver ring cannot hold the response beyond the 100 ms
  ring budget; the legacy non-ring direct seam retains the 300 ms derived-write
  bound plus ordinary scheduling tolerance;
- the receiver ring returns while a held D1 unsafe APPLY remains incomplete;
- replacing the receiver's waitUntil APPLY with an awaited APPLY is red;
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

## Duplicate activation guarantee and rolling updates

### Duplicate activation guarantee

Durable persistence arbitrates all authoritative state changes. Tag append,
reservation, allocator, bootstrap, outbox acknowledgement, and checkpoint
writes happen only after their storage transaction re-validates the relevant
head/version/epoch/token or expected predecessor. Derived D1 writes use
conflict-safe identity keys and exact readback.

### Platform basis and limit

The [Global uniqueness](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness)
section of the platform known-issues documentation is the basis for this
boundary. Uniqueness is enforced at event start and storage access, while an
event that never touches storage, or finishes after its last storage access,
can complete on a replaced instance. Rolling updates allow old and new code to
coexist temporarily.

### Audit table

| audited path | classification | public conclusion |
| --- | --- | --- |
| Tag append, reservation, allocator, bootstrap lifecycle, outbox acknowledgement, and projection checkpoint | safe by construction | Durable transactions re-validate the relevant facts before authoritative writes. |
| Read workers, TagState, projections, and CommitWorker recovery | caller-revalidated | Derived or recovered results are checked against durable source facts before use. |
| D1 delivery and identity rows | safe by construction | Conflict-safe writes and exact identity readback make retries idempotent; SUID/lineage conflicts remain incidents. |
| sample Bootstrap `/safe-lane/schedule` request | transaction-safe | Alarm state and the alarm are recorded together. |
| sample Bootstrap alarm | durable-state-first, derived/retryable, with cron recovery | Durable pending state is consumed before the safe-lane kick; missed or failed derived work is recoverable. |
| `safeLaneKickSchedulers` | advisory single-isolate coalescing only | Process-local coalescing is not authoritative scheduling state. |
| malformed Queue message | platform transport disposition, not business authority | Validation logs the disposition and calls `queued.retry()` before store initialization. |
| valid Queue message | caller-revalidated and derived | Ingress is observed, Bootstrap admission runs, delivery is processed, and the final disposition is `ack` or `retry`. |
| Worker/DO activation observations | observation-only | They emit `storageWrites: 0`, `usedForControl: false`, and do not influence public responses. |
| handlers that finish before storage or after their last storage access | platform-limited | They are not authoritative business writes or public state guarantees. |

### Rolling-update wire rule

The versioned input surfaces are the public commit request envelope and
internal downstream Queue message, both currently version 1. Preserve their
required members and current unknown-field behavior; an incompatible change
requires a new envelope/message version. Current public responses are
unversioned exact shapes: preserve their status, content type, keys, and
semantics. An incompatible response change requires a separately versioned
endpoint or response envelope. State and projector version values are not wire
versions. Internal Worker-to-Durable-Object request and response surfaces
(CommitWorker to Tag `/acquire` and `/append`, CommitWorker to Allocator
`/allocate` and `/attempts/:id`, ReadWorker to TagState `/read`, TagState to
Tag source reads, and Outbox to Tag internal routes) are currently unversioned.
During rolling updates, preserve their methods, paths, required request
members, accepted omissions and unknown-field behavior, response statuses,
content types, required members, and semantics in both directions between old
and new callers and callees. An incompatible internal change requires a
parallel versioned endpoint or envelope and a staged overlap in which both
generations remain mutually consumable until the old generation is retired.

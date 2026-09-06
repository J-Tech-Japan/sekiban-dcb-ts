# SDT-G44 — global-array completeness evidence

## Development-stage scope

This is an in-place development-schema change. There is no production data to
preserve: an incompatible test database may be deleted and recreated. This PR
therefore deliberately adds no legacy reader, data-copy job, mixed-version
fence, rollback marker, isolated namespace, or provider read-back topology.

During local verification, the stale development-only PostgreSQL `public`
schema was recreated because its pre-G32 foreign keys were incompatible with
the current test schema. No repository source, deployed database, or
production data was changed by that local reset.

The implementation does not claim to close the work intentionally left outside
this unit: global destination reconciliation, detector-health operations,
read-frontier/public-query semantics, import round trips, TagState separation,
and JOURNAL removal.

In particular, the fenced bootstrap import lane has no originating Tag source
partition. It deliberately creates neither a G44 source-partition entry nor a
global receipt/membership proof; import round-trip completeness is outside this
unit rather than being fabricated from a downstream record.

## Safety property implemented

```
source Tag transaction
  -> durable obligation + local receipt
  -> bounded/post-commit source registration attempt
  -> Queue handoff                         (not source acknowledgement)
  -> one D1 batch: event + source partition + membership + receipt
  -> D1 event/membership/receipt joined read-back
  -> Tag obligation acknowledgement
```

`serialized_dcb_global_memberships` and `serialized_dcb_global_receipts` are
written in the same D1 batch as the global event. The receipt’s semantic
identity is unique on `(service_id, event_id, event_digest, membership_tag)`.
The receiver cannot acknowledge the source merely because Queue accepted a
message, transport returned success, or a receipt exists without a matching
event and membership row.

The source partition registry is written by the successful atomic D1 admission
batch (with a non-blocking post-commit registration attempt retained for
discoverability), not by Queue arrival, sink arrival, or a runner’s planned count. The scanner
captures a snapshot of `partition_tag × obligation_sequence upper bound`,
fetches obligations from the corresponding private Tag DO storage seam, and
requires a contiguous exact range through each upper bound. Changed partition
sets, gaps, duplicates, truncation, and source/read errors make the result
`UNKNOWN`/`FAILED`; they cannot advance a healthy frontier.

The precise safety claim is: every registered source obligation either
converges to an exact global D1 receipt join or is enumerated as an
operator-visible unresolved state; it is never disguised as complete.
Unconditional delivery is not claimed: a permanent transport, credential, or
source fault cannot be made to deliver. Convergence time after a recoverable
fault is an operational SLO, not a guarantee.

## AC and oracle map

| Contract | Implementation / oracle |
| --- | --- |
| AC1 atomic global facts | `D1EventStore.recordDelivery`; `test/g44-global-completeness.spec.ts` injects a failed batch and proves event, membership, and receipt remain absent. |
| AC2 joined source acknowledgement | `DeliveryCore` reads `readGlobalReceiptJoin` before the Tag `/outbox/mark-delivered` callback; the Tag repeats the D1 join and verifies canonical bytes, digest, declared tags, local membership, and local sequence. |
| AC3 source universe | `serialized_dcb_source_partitions` is fed by Tag append. `GlobalCompletenessReconciler` owns the compound snapshot and rejects gaps, duplicate identities, and scan-time set changes. |
| AC4 delivery-zero detection | An actual Tag append with no receiver delivery produces one stable `GLOBAL_ARRAY_RECEIPT_ABSENT` `OPEN` finding. |
| AC5 detector health | never-run is `UNKNOWN`; source faults are `UNKNOWN`, receipt-read and unexpected scanner faults are `FAILED`, stale healthy records become `STALE`; a receipt-read fault records `GLOBAL_ARRAY_RECEIPT_UNAVAILABLE`, and a detector exception records `GLOBAL_ARRAY_DETECTOR_FAILURE`, both as `OPEN` before views can apply. |
| AC6 temporary policy | the sole internal coverage disposition is the literal `BLOCK/UNSETTLED`; queue and scheduled materialization are gated by it. It is not a public response schema. |
| AC7 poison / retention | source facts remain enumerable until a joined receipt. A poison source fact creates one stable `GLOBAL_ARRAY_POISON_OBLIGATION` `OPEN` finding; source/scanner/detector failures receive their own stable `OPEN` types. No owner, acknowledgement, correction, or closure workflow was added. |
| AC8 / AC10 | `scripts/g44-contract-check.mjs --self-test` proves isolated static guards; `scripts/g44-atomic-mutation-runner.mjs` mutates each atomic D1 write and the detector-stop branch against the real fixture. `ci-g44` runs both the normal and forced-red lanes. |

## Guard-isolation results

The G44 static checker’s self-test forces independent failures for removal of
membership persistence, removal of joined acknowledgement, Queue/sink or
runner-derived source-universe input, and removal of the detector’s
view-blocking return. The runtime mutation runner independently removes the
event, membership, and receipt writes from the actual batch, then removes the
detector block; each focused fixture must fail and the production source is
restored before the next mutation.

The runtime fixture additionally covers delivery disabled, an always-missing
receipt, source-page truncation, unreadable partitions with a stable
`GLOBAL_ARRAY_SOURCE_PARTITION_UNAVAILABLE` finding, scanner crashes with a
stable `GLOBAL_ARRAY_SCANNER_FAILURE` finding, partition-set change during
scan, stale health, detector exceptions with durable failed health and
`GLOBAL_ARRAY_DETECTOR_FAILURE`, scheduled materialization blocking, the
literal interim disposition, and a retry-exhausted Queue/DLQ handoff that
remains enumerable from the actual Tag obligation table.

## Reproduction

```sh
npm run test:g44
npm run test:g43
npm run test:d1
npm run test:g25
npm run test:g26
npm run test:g31
npm run test:g32
npm run lint
npm run typecheck
node scripts/g40-ci-coverage-check.mjs
```

`ci-g44` runs `test:g44` and then runs the same lane with
`SDT_G44_FORCE_FAILURE=1`, requiring the forced-red command to fail. The
existing `verify` aggregate depends on `ci-g44`; no existing CI gate was
removed or weakened.

## NO-GO record and open decisions

| NO-GO condition | Result |
| --- | --- |
| Queue/DLQ or delivery arrival defines the source universe | Rejected structurally and by self-test. |
| successful handoff can ack source | Rejected: only an event/membership/receipt joined read-back permits the source callback. |
| receipt without event/membership is success | Rejected by the D1 join and fixture. |
| partial/changed source scan is healthy | Rejected as `UNKNOWN` or `FAILED`; no healthy frontier advances. |
| detector fault allows views to apply | Rejected by the real `DeliveryCore` mutation fixture. |
| policy silently becomes delivery | Rejected: nonhealthy coverage is only `BLOCK/UNSETTLED`. |
| incident workflow expands beyond OPEN/UNRESOLVED | Not implemented. |
| Queue/DLQ retention can itself prove a completed global array | Rejected. Queue/DLQ are transport observations only; terminal source poison remains an enumerable obligation and becomes a stable `OPEN` finding. The physical DLQ service's retention lifecycle is not a second detector in this unit (ADR §4 item 8 is therefore only partially covered). |
| historical data compatibility is added | Not implemented; reset/recreate is the development-stage procedure. |
| G43 digest is replaced or recomputed from another representation | Not implemented; `eventDigest` continues to use `contracts/g43-digest-spec.json`. |

The final externally visible policy, including how a blocked global frontier is
presented to readers and who may settle an incident, remains intentionally
open: `O-G41-3`, `O-G41-4-2`, and `O-G41-7`.

## ADR §4 coverage boundary

The durable per-Tag obligation, full source envelope, and single-alarm retry
mechanism are consumed from SDT-G43. This unit fully covers the missing global
facts: the source partition registry, atomic event/membership/receipt join,
independent source scan, and health/coverage block. The Queue/DLQ terminal
case is partially covered: its source obligation remains enumerable and has a
stable incident, but G44 deliberately does not invent a separate DLQ-retention
detector. Destination reconciliation, external read-frontier semantics, and
import round-trip remain outside this unit.

## Required design write-back

The target repository contains no writable `means/13` or `means/14` authority
files. Design should record the following corrections in the host authority:

1. A healthy global frontier cannot be inferred from receipt arrival or the
   absence of a detector finding; it requires an independently enumerated,
   fully scanned source-partition snapshot.
2. Queue, DLQ, and transport success are not completeness authorities. A
   source obligation remains enumerable across retry, poison, DLQ, retention,
   credential, and shard failures until the exact D1 event/membership/receipt
   join is readable.

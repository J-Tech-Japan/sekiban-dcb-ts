# SDT-G12 Cosmos layout decision

## Decision

The Cosmos adapter is deliberately separate from the historical .NET Cosmos
layout. The serialized-dcb-v1 compatibility surface is the contract; there is
no undocumented cross-language document compatibility promise in this slice.
The separation keeps the TypeScript `PipelineStore` ports explicit and lets a
future interop adapter be added without changing the default Postgres provider
or the V1 wire.

The adapter uses the Linux vNext emulator in gateway mode for the executable
lane. The lane exercises the query, continuation, create-conflict, replace,
and `If-Match` conditional-write patterns used below. It does not depend on
change feed, parallel cross-partition queries, stored procedures, or triggers.

## Mapping

All containers use the service-scoped partition key `/serviceId`. Cosmos
document `id` values are escaped from the logical identity with
`encodeURIComponent`; the logical values below remain available as fields for
queries and evidence.

| Structure | Container | Partition-key value | Document id | SUID/order | State/checkpoint mapping |
| --- | --- | --- | --- | --- | --- |
| Durable events and arrival observations | `dcb-events` | `serviceId` | escaped `eventId` | `suid` is opaque and sorted with the V1 UTF-8 ordinal in the adapter; `eventId` breaks ties | payload, complete `eventTags`, first/last arrival, max lag, and idempotent per-tag arrival facts live in one event document |
| Dynamic lag estimate | `dcb-lag-estimates` | `serviceId` | `serviceId` | no source ordering | `estimateMs` plus `observedAt`; reads apply the same decay rule as Postgres |
| Detector pending arrivals | `dcb-pending-arrivals` | `serviceId` | escaped `eventId` | no source ordering | attempt identity, expected/observed paths, first observation, and lag bound |
| Detector findings | `dcb-findings` | `serviceId` | escaped `eventId`, path, classification | list is deterministic by observed time/event/path | append-only `MISSING_STABLE`, `EXCLUDED_AUDITED`, or `RESOLVED_LATE` record |
| Projection state/checkpoint | `dcb-projection-checkpoints` | `serviceId` | escaped `projectionId` | checkpoint stores opaque last SUID | `stateJson`, version, and updated time advance with an `If-Match` CAS |

This is the complete mapping for the three contract areas: event/detector
durability, detector observations, and projection state. No request header can
select a different service partition or container.

## Executable branch fixture

`scripts/store-contract.mjs` runs the same `PipelineStore` contract assertions
against the adapter's document-client seam and against a real emulator when the
Cosmos lane supplies `COSMOS_ENDPOINT`, `COSMOS_KEY`, and `COSMOS_DATABASE`.
The emulator runner fails closed when any required value is absent; it never
turns an unavailable emulator into a skipped green test. The fixture covers
event-id idempotency/conflict, bytewise SUID ordering, detector de-duplication,
checkpoint CAS, and re-delivery after injected write failures.

The deliberately-separate branch is executable rather than documentation-only:
`test/cosmos-pipeline.spec.ts` asserts the five TypeScript container names,
the `/serviceId` path and service-id partition value for every container, and
that none of the names collides with the historical .NET `events`/`tags`/`states`
layout. A future interop adapter must therefore choose a new explicit provider
instead of silently sharing these containers. The same spec drives both the
Cosmos-backed query and tag-read handlers with production-shaped namespace
headers, asserting that the service id and partition key remain
`serialized-dcb-v1`.

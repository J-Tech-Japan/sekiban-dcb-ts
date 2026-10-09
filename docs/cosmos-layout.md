# Experimental Cosmos provider

Cosmos is an experimental, explicit opt-in provider. Postgres remains the
runtime default and the generated starter remains D1. Merely configuring
Cosmos values, adding a request field, or adding a request header never
selects this provider.

## Layout contract

The sole handwritten authority is
[`contracts/cosmos-layout.json`](../contracts/cosmos-layout.json). The runtime
module and starter descriptor are generated from it. The event record fields
continue to follow the logical Cosmos shape in
[`contracts/event-store-ddl.json`](../contracts/event-store-ddl.json).

| `key` | `container` | `partition path` | `partition values` |
| --- | --- | --- | --- |
| `events` | `dcb-events` | `/pk` | `{serviceId}|{eventId}; {serviceId}|__dcb_event_ops__` |
| `lagEstimates` | `dcb-lag-estimates` | `/serviceId` | `{serviceId}` |
| `pendingArrivals` | `dcb-pending-arrivals` | `/serviceId` | `{serviceId}` |
| `findings` | `dcb-findings` | `/serviceId` | `{serviceId}` |
| `checkpoints` | `dcb-projection-checkpoints` | `/serviceId` | `{serviceId}` |

Logical event documents use the canonical event id. Event sidecars and service
guard documents use the adapter's `safeId` encoding. Auxiliary documents use
their existing logical identity encoded with `safeId` where the adapter does
so. The event container is intentionally mixed: logical events and event
sidecars use `serviceId|eventId`, while allocator-lineage, SUID-binding, and
delivery-incident guards use the reserved
`serviceId|__dcb_event_ops__` partition.

## Selecting the provider

Import the experimental entry point and pass its factory in source:

```ts
import { createRuntimeWorker } from "@sekiban/dcb-runtime";
import { createCosmosStoreProvider } from "@sekiban/dcb-runtime/cosmos";

const worker = createRuntimeWorker({
  storeProvider: createCosmosStoreProvider(),
});
```

The factory resolves `COSMOS_ENDPOINT` and `COSMOS_DATABASE` deployment values
and the `COSMOS_KEY` secret binding for each invocation. A missing, empty, or
partial triple fails with a redacted configuration error before a network
request. Configure the key with the deployment secret facility:

```sh
npx wrangler secret put COSMOS_KEY
```

Do not put the key, a connection string, or a usable credential in `vars`, a
committed file, a log, or a receipt. Tests may inject a document client
directly without credentials. Static Node configuration is also supported only
when all three endpoint, database, and key values are supplied together.

## Initialization and supported behavior

Initialization creates the database and all five containers from the generated
layout. Event scans are cross-partition queries filtered by service id because
logical events do not share one service partition. Auxiliary reads use their
service-local partition. The shared store contract covers create/read/query,
continuation paging, idempotency, conditional replacement, detector state,
and conflict behavior.

Bootstrap export/import is experimental. Use a fresh, isolated target database,
with a fixed export high watermark and the provider verifier after replay.
This is not a production-support promise or a production-account check.

The pinned Linux vNext emulator is the local and pull-request witness:

```sh
npm run ci:local -- --lane cosmos
```

The lane fails when Docker, readiness, required values, either real contract,
container cleanup, or protected key-file cleanup fails. An unavailable
emulator is never reported as a skipped success.

Cosmos live tag rebuild, a live cross-provider round trip, correction
application, and a real Azure account probe are unsupported. The sealed rebuild
command remains PostgreSQL-only.

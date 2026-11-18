# D1 materialized-view core

The MV core is an additive read-side backing. The existing memory projection
backing and all Serialized DCB V1 HTTP shapes remain unchanged.

## Bindings and migrations

`D1` remains the PipelineStore binding. `D1_MV` is a separate D1 binding for
`mv_instances`, `mv_active_generations`, `mv_rows`, `mv_index_entries`, and the
short-lived `mv_atomic_guards` table. MV checkpoints are stored with the MV
rows in `D1_MV`; they are not copied into PipelineStore. The schema is applied
by the versioned `migrations/mv/0001_materialized_views.sql` migration. Runtime
code never executes DDL.

## Materializer and atomic apply

`@sekiban/dcb-core` exposes `defineRowMaterializer`. A materializer declares a
finite set of typed indexes and returns a pure mutation plan. Row values are
validated as JSON before persistence. The runtime converts that plan to bound
prepared statements; callers cannot provide SQL identifiers or JSON paths.

`D1MaterializedViewStore.applyMutationsAndAdvanceCheckpoint` sends the guard,
row deletes/upserts, index deletes/inserts, and checkpoint update in one D1
`batch()`. A stale `expectedLastSuid` deliberately violates the guard's
`NOT NULL` constraint, so D1 rolls back the entire call and the typed
`MaterializedViewCasError` is returned. Generation promotion uses the same
pattern for the active pointer. Candidate generations are never read by the
query backing and a failed or interrupted rebuild cannot alter the active
generation.

## Catch-up and query backing

`MaterializedViewCatchUpRuntime` reads the source in opaque bytewise SUID order,
stops at the first event outside the published SafeWindow, and returns an
indeterminate result when the lag estimate exceeds the published ceiling. A
source order violation is recorded through the existing delivery-incident
port before catch-up fails closed. Composition chooses either the existing
memory projection or the explicit D1 MV port with `selectQueryBacking`; that
choice is deployment composition, never request data. `createRuntimeWorker`
accepts `queryBacking: "d1-mv"` (and the optional typed
`materializedViewQueryPort` composition port); with the `D1_MV` binding this
routes both serialized query endpoints through `readRowsFromBacking`. MV rows
are converted to the existing V1 list/query result shape and ordered by their
opaque source SUID, so selecting D1 MV does not add or rename wire fields.
Unsupported query parameters are refused before backing selection, so a D1 MV
read never observes them. `RoomProjector` is registered as a scalar projector
and is read by tag state, not as a parameterized room query.

## Passive projection status

Heartbeats are rows in the event-source table `dcb_projection_statuses`.
PipelineStore D1 and PostgreSQL can store them. Cosmos has no status registry,
so a status read on that provider returns `projection_status_unsupported`.

Apply the versioned D1 or PostgreSQL migration before serving the route. The
runtime does not create the table. A missing table or a failed event sample
returns `projection_status_unavailable`.

`POST /api/sekiban/serialized/projection-status` accepts only a strict version-1
body:

```json
{"version":1,"serviceId":null,"projectorName":null,"projectorVersion":null}
```

The response is a best-effort sample. `isFresh` means the heartbeat was recorded
within two minutes and its lease is absent or still unexpired. `isCaughtUp` is
true only when the sampled remaining count is exactly zero, the row is fresh,
the phase is `active` or `caughtUp`, the row is not faulted, and no second fresh
cluster conflicts. A failed sample fails the request. An unknown remaining
count is never reported as zero.

A status read does not open the materialized-view database, start catch-up, or
write a heartbeat. Query, list-query, and wait paths do not publish status.
`build`, `follow`, `rebuild`, and `promote` publish after their own work.
A publication failure does not change that result.

Authenticated generation actions are a separate surface and are not on this route.

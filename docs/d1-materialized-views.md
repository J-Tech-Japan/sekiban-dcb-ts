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

Apply every file in `migrations/mv` in order. Migration
`0010_g152_force_reverse_audit.sql` is a required upgrade for every D1 MV
deployment, whether or not the force-reverse route is mounted: it adds the
`switch_kind`, `switch_reason`, and `switched_at` audit columns to
`mv_active_generations`, and start, switch, and force reverse all write them.
`D1MaterializedViewStore.initialize()` reads those columns and fails when the
migration is missing, so a skipped upgrade stops at startup instead of in the
middle of a switch. Pointer rows written before 0010 read as `legacy` until
the next start, switch, or force reverse rewrites them.

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

A public serialized status read on this route does not open the
materialized-view database, start catch-up, or write a heartbeat. Query, list-query, and wait paths do not publish status.
`build`, `follow`, `rebuild`, and `promote` publish after their own work.
A publication failure does not change that result.

Authenticated generation actions are a separate surface and are not on this
route; see [Authenticated materialized-view actions](#authenticated-materialized-view-actions).
Their status read deliberately consults target facts.

## Authenticated materialized-view actions

Register the row materializers that operators may drive. The registry is
server code: a request can only name a registered id. It cannot supply code,
a table, a provider, a definition version, a generation to prepare, a service
id, hooks, or catch-up options. Ids must be unique; a duplicate id fails worker
creation. The default registry is empty.

```ts
import { createRuntimeWorker } from "@sekiban/dcb-runtime";
import { createCloudflareOnlyRuntimeWorker } from "@sekiban/dcb-runtime/cloudflare";
import { bookingRows } from "./booking-mv";

// Ordinary (PostgreSQL or explicit provider) composition.
export const ordinary = createRuntimeWorker({ materializedViewActions: [bookingRows] });

// Cloudflare-only two-D1 composition.
export const cloudflareOnly = createCloudflareOnlyRuntimeWorker({ materializedViewActions: [bookingRows] });
```

Every route uses the operator repair bearer. Configure `REPAIR_OPERATOR_TOKEN`
as a Worker secret and send `Authorization: Bearer <token>`. The token is
compared exactly. An unset, non-string, empty, or whitespace-only binding
returns 404 for the whole `/operator/materialized-views` prefix. A missing or
wrong bearer returns 401. Authentication runs before the view id, query, or
body is parsed and before the service identity, event source, `D1_MV`, or any
Durable Object is touched. The service id always comes from the server's
service identity provider.

| Method and path | Input | Operation | Success |
| --- | --- | --- | --- |
| `POST /operator/materialized-views/:viewId/ensure-started` | empty body or `{}` | read active; `build` only when absent | `{ "result", "status" }`; `result` is `null` when already started |
| `POST /operator/materialized-views/:viewId/refresh` | empty body or `{}` | `follow` once | `{ "result", "status" }` |
| `POST /operator/materialized-views/:viewId/prepare` | empty body, `{}`, or `{ "rebuildId": "..." }` | `rebuild` once | `result.candidateGeneration`, `result.rebuildId`; serving pointer unchanged |
| `POST /operator/materialized-views/:viewId/switch` | `{ "candidateGeneration": 1, "expectedActiveGeneration": 0 }` | `promote` with that expectation | `result` is the new active instance |
| `POST /operator/materialized-views/:viewId/force-reverse` | `{ "retainedGeneration": 0, "expectedActiveGeneration": 1, "reason": "..." }` | break-glass reverse; see [Force reverse](#force-reverse) | `result` is the re-served active instance |
| `GET /operator/materialized-views/:viewId/status` | none | read active instance, target facts, heartbeat | runtime status object |
| `GET /operator/materialized-views/:viewId/received?sortableUniqueId=...` | one sortable unique id | one source and one target point read | `true` or `false` |

`rebuildId` is optional, non-empty, and at most 128 UTF-8 bytes. It labels the
rebuild proof; it is not an idempotency key, so a repeated prepare creates
another candidate. `candidateGeneration` and `expectedActiveGeneration` are both
required non-negative safe integers; `expectedActiveGeneration` may be `null`
only to assert that no generation is active. Encode the view id as one path
segment. A view id containing `/` cannot be addressed.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `materialized_view_action_invalid_request` | malformed id, query, or body |
| 401 | `operator_auth_required` | missing or wrong bearer |
| 404 | `operator_repair_route_not_found` | operator token not configured |
| 404 | `materialized_view_action_not_found` | unknown view, action, or method |
| 409 | `materialized_view_not_started` | refresh without an active generation |
| 409 | `materialized_view_definition_version_mismatch` | registered version differs from the serving generation |
| 409 | `materialized_view_switch_conflict` | expected active generation or candidate state did not match |
| 409 | `materialized_view_force_reverse_conflict` | force reverse lost its fence: the active pointer or retained state changed |
| 409 | `materialized_view_force_reverse_rejected` | the retained generation is not retired, is missing, or has quarantine history |
| 409 | `materialized_view_action_conflict` | catch-up did not converge or the candidate is not promotable |
| 501 | `materialized_view_action_unsupported` | the event source lacks status or point-read support |
| 503 | `materialized_view_action_unavailable` | `D1_MV`, migrations, or a fact read is unavailable |
| 503 | `scope.identity_missing` | no deployment service identity |

Error bodies are fixed text and never echo SQL, causes, the bearer, or the
request.

Each request runs one action. A committed action stays successful when its
follow-up status read fails; the response then has `"status": null`. Actions
publish the heartbeat with activation `operator` through the same two-second
best-effort publication as scheduled catch-up, which keeps activation
`scheduled`. Status, received, and an already-started ensure publish nothing.

### Version changes: prepare, then switch

`refresh`, and every scheduled `follow`, refuse a generation whose stored
definition version differs from the registered materializer. The serving rows
and definition version stay unchanged. After deploying a new materializer
version N+1:

1. `prepare` builds a candidate with N+1 while N keeps serving queries.
2. `switch` with `expectedActiveGeneration` set to N's generation cuts over.

Switch promptly: N stops following new events until the cutover. An incomplete
or failed prepare never moves the active pointer. Two switches with the same
expectation race on the store's atomic promotion guard; one returns 200 and the
other 409. The caller decides whether to retry with a new expectation.

To roll back a bad switch to the retained predecessor, use
[Force reverse](#force-reverse). Request-driven deactivation is not offered.

### Mounting behind composeFetch

The routes are not in `SERIALIZED_PATHS`, so a default `composeFetch` mount does
not forward them. Opt in with `extraPrefixes`. The mount's `authorize` callback
runs first; the runtime bearer check still applies.

```ts
composeFetch({
  application,
  sekiban: {
    prefix: "/sekiban",
    fetch: runtime.fetch,
    authorize: (request) => isOperatorNetwork(request),
    extraPrefixes: ["/operator/materialized-views"],
  },
});
```

## Force reverse

`POST /operator/materialized-views/:viewId/force-reverse` is a break-glass
rollback. It re-serves a retained predecessor generation after an ordinary
switch went wrong. It uses the same bearer, registry, and fail-closed order as
the other actions, and it is mounted only through the same `extraPrefixes`
opt-in.

```json
{ "retainedGeneration": 0, "expectedActiveGeneration": 1, "reason": "roll back bad switch" }
```

The body has exactly these three members:

- `retainedGeneration` and `expectedActiveGeneration` are non-negative safe
  integers. `expectedActiveGeneration` is required and never `null`.
- The reverse is backwards only: `retainedGeneration` must be strictly less
  than `expectedActiveGeneration`. Anything else is a 400.
- `reason` is trimmed and must then be 1 to 1024 characters with no control
  characters. It is stored on the active pointer and is never echoed in an
  error.

The retained generation must be `retired`, the state a generation enters when
an ordinary switch replaces it. A candidate, the current active generation, or
a missing generation returns 409 `materialized_view_force_reverse_rejected`.
`switch` still accepts only candidates, so it cannot move backwards.

One D1 batch fences the whole move. It checks that the retained generation is
still retired, the active pointer still names `expectedActiveGeneration`, and
that generation is still active. It then retires the current active
generation, activates the retained one, and moves the pointer. If any check
fails, nothing changes and the response is 409
`materialized_view_force_reverse_conflict`. Two concurrent reverses with the
same expectation produce one 200 and one 409.

Force reverse needs no rebuild proof. It does refuse a retained generation
that has any ordering-quarantine row, open or resolved. A switch resolves the
leaving generation's quarantine only because that generation stopped serving,
not because it was repaired, so re-serving it would expose known-bad rows.
Force reverse never creates, resolves, reopens, or deletes quarantine rows.
If the generation you reverse away from has an open quarantine, that row stays
open. It no longer gates safe reads, because the gate follows the active
generation. It still blocks a later ordinary switch to an unproven candidate,
and `prepare` still targets it for the rebuild proof. Status reports it as
`leavingGenerationQuarantineOpen: true`.

The pointer records `switchKind: "forced"`, the trimmed reason, and the switch
time. Start and switch record `ordinary` and clear the reason. The heartbeat
for the re-served definition version records the same forced switch. Response
bodies match `switch`: `{ "result", "status" }`.

Force reverse does not rewrite `definition_version`. If the retained
generation was built by an older materializer than the one registered now,
`refresh` and scheduled catch-up fail with
`materialized_view_definition_version_mismatch`. Redeploy the materializer
version that matches the re-served generation, or prepare and switch a new
candidate.

Force reverse relies on retired generations being kept. Nothing removes them
today. Any future cleanup of retired generations must keep a reverse-eligible
predecessor, or must not run while force reverse is in use.

## Materialized-view runtime status

`GET .../status` returns the registered view's runtime status. The active
instance in `D1_MV` decides the serving generation, version, and position. The
heartbeat is best-effort evidence for that definition version.

| Member | Value |
| --- | --- |
| `serviceId` | server service identity |
| `viewName` | registered materializer id |
| `viewVersion` | active definition version; `null` before start |
| `started` | an active generation exists |
| `catchUpInProgress`, `isCatchUpActive` | fresh, non-conflicting, non-faulted heartbeat in `starting` or `catchingUp` |
| `subscriptionActive` | always `false` |
| `bufferedEventCount` | always `0` |
| `currentPosition` | active checkpoint; `null` when empty |
| `lastReceivedSortableUniqueId` | heartbeat traversed position |
| `lastError` | `materialized view catch-up faulted` when the heartbeat is faulted |
| `lastCatchUpStartedAt` | always `null` |
| `lastCatchUpCompletedAt`, `lastCatchUpAttemptAt` | heartbeat record time in UTC |
| `consecutiveEmptyBatches`, `catchUpBatchSkipCount` | always `0` |
| `lastProgressSortableUniqueId` | heartbeat applied position |
| `needsImmediateCatchUp` | fresh, non-conflicting, non-faulted heartbeat that is not caught up |
| `catchUpHalted` | faulted heartbeat, checkpoint-ahead finding, target poison, or open ordering quarantine |
| `generation`, `generationStatus` | active generation and its status |
| `rebuildRequired` | active generation needs a rebuild |
| `isFresh` | fresh heartbeat without a conflicting cluster |
| `switchKind` | how the active pointer last moved: `ordinary`, `forced`, or `legacy` (written before migration 0010); `null` before start |
| `switchReason` | operator reason of a forced switch; otherwise `null` |
| `switchedAt` | pointer switch time in UTC; `null` before start or for `legacy` rows |
| `leavingGenerationQuarantineOpen` | an open ordering quarantine remains on a generation that is not active |

A missing, stale, expired, or conflicting heartbeat never reports activity or
`needsImmediateCatchUp`. Missing heartbeat fields are `null`. The heartbeat key
has the definition version but no generation, so while a same-version candidate
is being prepared the heartbeat may describe that candidate. Generation fields
always come from the active instance. Status needs an event source with the
status registry (D1 or PostgreSQL); otherwise it returns 501. A failed read
returns 503. Status never starts catch-up or writes.

## One-shot received check

`GET .../received?sortableUniqueId=...` answers once whether the active
generation has observed that event. It uses the same facts as the D1
materialized-view query wait, without waiting:

1. The source looks up the id. An incident or contradiction returns 503.
2. The target reads the active generation's facts. Checkpoint-ahead,
   rebuild-required, or poison returns 503.
3. A pending id or no active generation returns `false`.
4. A uniquely stored event returns `true` when the active generation holds its
   receipt or its checkpoint is at or after the id.
5. Otherwise it returns `false`.

Each request makes at most one source and one target point read. It never
scans history, retries, sleeps, starts catch-up, or writes. A `true` answer can
become stale after a later switch; use query wait for read-your-write. The
check needs the D1 event source; other providers return 501.

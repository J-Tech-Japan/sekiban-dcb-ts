# Meeting-room sample

**Canonical Cloudflare getting-started sample** for sekiban-dcb-ts.

Start here: [`docs/getting-started-cloudflare.md`](docs/getting-started-cloudflare.md)
(migrate both D1s → deploy → smoke → C-0 notes).

This Worker is a small consumer of the released packages available from npm
(`@sekiban/dcb-{core,domain,client,runtime}@0.3.0`) plus
`@sekiban/dcb-cloudflare` `0.2.0`, linked from the workspace while developing in
this repository.
The helper mounts storage beside
a caller's own Worker; this sample is not that caller's only application.
For tip Cloudflare speed/latency deploys use `./scripts/deploy/npm-consumer-deploy.sh`
(it packs this worktree). The registry matched-set dry-run is `npm run test:sample:registry-consumer`.
Domain definitions live in `src/domain.ts`; the sample does not deep-import a
package `src` directory.

The application surface is `/api/commands/{create-room,reserve-room,cancel-reservation,release-room}`
plus the read-only `/api/read/room?roomId=...` and
`/api/read/reservation?reservationId=...` wrappers used by the browser.
`GET /api/read/reservations` returns a decoded page from
`ListActiveReservationsByRoomQuery`. `GET /api/read/reservation-count?roomId=...`
returns `{ count }` from `CountActiveReservationsByRoomQuery`. Optional
`roomId` filters the list. `GetReservationListQuery` remains the metadata-only
list. Each
command is authored with `@sekiban/dcb-domain` and reaches the runtime through
`toRuntimeDomain()` and the internal `RUNTIME` service binding. The booking
workflow is deliberately two commits: if the reservation step conflicts, the
durable room creation is retained. `RoomProjector` and `ReservationProjector`
are both immediate-preferred in the production sample, preserving the delivery
fan-out behavior while keeping the checked-in per-view delivery policy
authoritative; deployment variables only provide the second opt-in and safety
budget.

`src/domain.ts` is the executable C#⇄TypeScript authoring example. Events own
their tags, state is a closed `status` union, command reads are declared with
`read`/`readSet`, and the command clock is captured separately from the
allocator `OrderClock`. See [`docs/domain-authoring.md`](../../docs/domain-authoring.md)
and the current mapping checks for the portable contract.

`public/` is served directly by Workers Assets. There is no frontend framework
or build step: `index.html` loads `app.js`, which uses `fetch` only against the
application routes. The UI compares the committed `sortableUniqueId` to the
read response's `lastSortedUniqueId` using the V1 ordinal; a head below the
commit remains pending, and only a head at or above it becomes visible. The
published 120,000ms SafeWindow bound is the UI timeout. Polling cadence and
the E2E harness grace period never decide visibility.

The five serialized V1 paths are available only under `/conformance/v1/*`.
`CONFORMANCE_TOKEN` is configured only when it contains a non-whitespace
character, and the comparison keeps those exact bytes. An unconfigured binding
returns 404. A missing or wrong credential returns 403. Bare V1 paths are not a
public fallback. Hyperdrive query caching is disabled before conformance and
measurement runs.

## Cloudflare-only variant

`wrangler.cloudflare-only.jsonc` is the named composition for the Cloudflare-only composition.
It has two independent D1 bindings (`D1` for the PipelineStore and `D1_MV` for
materialized-view rows/checkpoints), the same Journal/Allocator/Tag Durable
Objects, and a Queue for durable outbox delivery. It deliberately has no
Hyperdrive, Postgres, or experimental Cosmos binding. The Queue consumer applies each
*stored* outcome to the atomic unsafe port, so the reservation list can show
an immediate tentative view from the composed `D1_MV` read. `/api/read/room`
is not that materialized-view query. It is a keyed serialized tag-state read:
`GET /api/read/room?roomId=...` returns the decoded `RoomProjector` state, its
version, and `lastSortedUniqueId`. The reservation list and count routes use
the authored contracts against that same `D1_MV` backing when the Cloudflare-only
worker is selected. A checkpoint row may omit `roomId`; the decoded item omits
it too. A stored `userId` is not part of the meeting-room row.
SafeWindow catch-up remains the definitive ordered fold; an unsafe failure is
retried and is never silently acknowledged. Cron is only the recovery net for
safe catch-up and residual kick/GC work. The existing PG config stays available
as the alternative.

The Cloudflare-only deployment uses the non-secret `SDT_SERVICE_ID` Wrangler
var as part of its deployment lifecycle. Change it when replacing the DO
namespace; no client/internal header can select a namespace. Apply the two
versioned migrations before the first deployment (see
[`docs/getting-started-cloudflare.md`](docs/getting-started-cloudflare.md)):

```sh
./samples/meeting-room/scripts/migrate-remote.sh
export REPAIR_OPERATOR_TOKEN_FILE=/path/to/repair-token
export CONFORMANCE_TOKEN_FILE=/path/to/conformance-token
./samples/meeting-room/scripts/deploy.sh
```

`REPAIR_OPERATOR_TOKEN_FILE` is required for a live deploy. `CONFORMANCE_TOKEN_FILE` is optional. Both files must be readable, regular, and contain a non-whitespace character. The wrapper pipes each supplied file to `wrangler secret put` and does not print it. Rotation uses the same command after the file is replaced. `scripts/deploy/cloudflare-only-deploy.sh` and the live branch of `scripts/deploy/npm-consumer-deploy.sh` use those same two variables.

Bundle-only, with no token file and no remote migration, secret, deployment list, or live deploy:

```sh
./samples/meeting-room/scripts/deploy.sh --dry-run
./samples/meeting-room/scripts/deploy.sh -- --dry-run
```

`G99_DRY_RUN=1 ./scripts/deploy/npm-consumer-deploy.sh` packs and installs only. It does not provision a secret or deploy.

## Offline composition profiles

Three offline provider-composition profiles describe the checked-in sample
authorities: the two Wrangler files and the experimental Cosmos layout
contract. Each is validated on its own; profiles are never merged.

| Profile | Manifest | Local mapping | Wrangler file |
| --- | --- | --- | --- |
| `meeting-room-cloudflare` | `contracts/provider-composition.json` | `contracts/provider-composition.local-mapping.json` | `wrangler.cloudflare-only.jsonc` |
| `meeting-room-postgres` | `contracts/provider-composition.meeting-room-postgres.json` | `contracts/provider-composition.meeting-room-postgres.local-mapping.json` | `wrangler.jsonc` |
| `cosmos-experimental` | `contracts/provider-composition.cosmos-experimental.json` | `contracts/provider-composition.cosmos-experimental.local-mapping.json` | none (code-composed) |

The unsuffixed `contracts/provider-composition.json` filename is historical; it
is the Cloudflare-only manifest. Those six files are the only
`provider-composition*.json` contracts the check accepts; any other one fails.

`npm run test:provider:composition` checks all three profiles and prints their
three digests. `npm run test:deploy:composition` with no arguments checks the
Cloudflare-only profile only, as before.

The `meeting-room-postgres` profile mirrors `wrangler.jsonc` exactly:
`HYPERDRIVE` for the event store, the `RUNTIME` service binding to this
Worker's `runtime` entrypoint, one Queue producer and consumer, and the
Allocator, Journal, Tag, and TagState Durable Objects. It has no `D1_MV`, no
dead-letter queue, and no `BOOTSTRAP` Durable Object; adding any of them, a D1
binding, a doorbell service, a Cosmos or `POSTGRES_URL` binding or var, a
Hyperdrive `localConnectionString`, or a named `env` block fails the check
until the profile is changed deliberately. `SDT_SERVICE_ID` is supplied at
deploy time and is not required in, or proven by, the offline check.

The check expects the checked-in Hyperdrive placeholder id, so a locally
substituted id fails it. Do not commit a real Hyperdrive id or connection
string; local development may still pass a connection through the environment
outside Wrangler.

The `cosmos-experimental` profile describes the experimental Cosmos store
selected explicitly in code with `createCosmosStoreProvider` and the
`COSMOS_ENDPOINT`, `COSMOS_DATABASE`, and `COSMOS_KEY` environment role labels.
Cosmos stays an opt-in; it is not the default runtime. The profile's
configuration authority is the experimental Cosmos layout contract,
`contracts/cosmos-layout.json`, referenced by path and digest rather than
copied; the check screens that file for credential-shaped values before it
parses or hashes it. The local mapping holds placeholder endpoint and database
ids and `keyRequired` only; it never holds a key. The profile proves the
default layout and the environment role labels only: an injected client or a
`containers` override is refused, not ignored. There is no Cosmos Wrangler
file, Worker, Queue, or Durable Object, and no deployable Cosmos Worker in this
sample.

`npm run test:remote:topology` runs the self-test of the remote Queue consumer
reconcile check, and
`node scripts/g155-remote-topology-reconcile.mjs --remote-snapshot <file>`
checks a consumer snapshot the operator saved for the Cloudflare-only profile's
work queue. The snapshot is `{ "queue": "<consumer queue>", "consumers": [ ... ] }`,
and the queue name must match the local mapping. The declared consumers come
from the profile, and the comparison is an exact set: a missing or stale
consumer, a duplicate, or a pull consumer without a Worker script fails.
After the set comparison, each work-queue consumer must also carry
`dead_letter_queue` naming the local mapping's dead-letter queue, otherwise the
check fails, so a snapshot saved without that field now fails; other extra
fields on a consumer row are ignored. The check never contacts Cloudflare,
refuses `--fetch-live`, and deletes nothing; a green result proves the supplied
snapshot, not the account.

That single `{ "queue", "consumers" }` snapshot checks the work queue only; it
is not proof about the dead-letter queue. A bundle snapshot
`{ "queues": [ <work queue envelope>, <dead-letter queue envelope> ] }` holds
exactly two such envelopes, in either order, bound by queue name to the local
mapping's consumer queue and dead-letter queue. It also checks the dead-letter
queue's consumers against the profile, which declares none, so any consumer on
the dead-letter queue fails; consumers on the dead-letter queue itself are not
checked for the `dead_letter_queue` field. A green bundle proves the supplied
snapshot's dead-letter consumer set only; it does not check the producer or the
live account.

A producer snapshot
`{ "queue": "<producer queue>", "producers": [ { "binding": "<binding>", "queue": "<producer queue>" } ] }`
checks the Queue producer bindings of the Cloudflare-only profile's Worker. It
is not a raw Cloudflare API response: reduce the deployed Worker's
`queues.producers` rows (the `binding` and `queue` fields of the Wrangler
configuration) to exactly these two top-level keys, or the check fails. The
envelope `queue` and every row's `queue` must equal the local mapping's
producer queue (`queue`, not `consumerQueue`). The declared bindings come from
the profile, and the comparison is an exact set of binding names: a missing,
stale, or duplicated binding fails. A row without a `binding` is reported as an
identity fault at that row's `binding`, unlike a consumer row without a Worker
script, which is reported as an undeclared consumer; other extra fields on a
producer row are ignored. A producer snapshot cannot be combined with consumers
or placed inside a bundle, and a green result reports `"mode": "producers"`.
The check never contacts Cloudflare and refuses `--fetch-live`; a green result
proves the supplied snapshot, not the account.

All profiles use the repository's shared validation core. It checks the
checked-in sample authority, local mapping, Worker exports, and (for the
Cloudflare-only profile) generated accessors before any deploy continuation; it
does not query live Cloudflare or Azure state or create resources. A green
check proves the checked-in tree only, not remote state, deploy-time overrides,
applied Postgres schema migrations, or Cosmos account and container state.

# Meeting-room sample

**Canonical Cloudflare getting-started sample** for sekiban-dcb-ts.

Start here: [`docs/getting-started-cloudflare.md`](docs/getting-started-cloudflare.md)
(migrate both D1s → deploy → smoke → C-0 notes).

This Worker is a small consumer of the matched npm packages
(`@sekiban/dcb-{core,domain,client,runtime}@0.2.0`) plus the published npm
helper `@sekiban/dcb-cloudflare`, linked from the workspace while developing in
this repository. The helper mounts storage beside
a caller's own Worker; this sample is not that caller's only application.
For tip Cloudflare speed/latency deploys use `./scripts/deploy/npm-consumer-deploy.sh`
(it packs this worktree). The registry `0.2.0` dry-run is `npm run test:sample:registry-consumer`.
Domain definitions live in `src/domain.ts`; the sample does not deep-import a
package `src` directory.

The application surface is `/api/commands/{create-room,reserve-room,cancel-reservation,release-room}`
plus the read-only `/api/read/room?roomId=...` and
`/api/read/reservation?reservationId=...` wrappers used by the browser. Each
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

The five serialized V1 paths are available only under `/conformance/v1/*` and
require `Authorization: Bearer <CONFORMANCE_TOKEN>`. Bare V1 paths are not a
public fallback. `CONFORMANCE_TOKEN` is a Wrangler secret, and Hyperdrive
query caching is disabled before conformance and measurement runs.

## Cloudflare-only variant

`wrangler.cloudflare-only.jsonc` is the named composition for the Cloudflare-only composition.
It has two independent D1 bindings (`D1` for the PipelineStore and `D1_MV` for
materialized-view rows/checkpoints), the same Journal/Allocator/Tag Durable
Objects, and a Queue for durable outbox delivery. It deliberately has no
Hyperdrive, Postgres, or experimental Cosmos binding. The Queue consumer applies each
*stored* outcome to the atomic unsafe port, so the reservation list and room
query can show an immediate tentative winner from the composed `D1_MV` read.
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
npx wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --keep-vars
```

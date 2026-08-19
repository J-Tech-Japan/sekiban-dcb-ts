# Meeting-room sample

This Worker is a small consumer of the three public workspace packages. Its
domain definitions live in `src/domain.ts`; it does not deep-import a package
`src` directory or copy the runtime's private registries.

The application surface is `/api/commands/{create-room,reserve-room,cancel-reservation,release-room}`
plus the read-only `/api/read/room?roomId=...` and
`/api/read/reservation?reservationId=...` wrappers used by the browser. Each
command uses the claim-ledger executor through the internal `RUNTIME` service
binding. The booking workflow is deliberately two commits: if the reservation
step conflicts, the durable room creation is retained.

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

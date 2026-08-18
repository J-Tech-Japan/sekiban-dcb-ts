# Meeting-room sample

This Worker is a small consumer of the three public workspace packages. Its
domain definitions live in `src/domain.ts`; it does not deep-import a package
`src` directory or copy the runtime's private registries.

The application surface is `/api/commands/{create-room,reserve-room,cancel-reservation,release-room}`.
Each command uses the claim-ledger executor through the internal `RUNTIME`
service binding. The booking workflow is deliberately two commits: if the
reservation step conflicts, the durable room creation is retained.

The five serialized V1 paths are available only under `/conformance/v1/*` and
require `Authorization: Bearer <CONFORMANCE_TOKEN>`. Bare V1 paths are not a
public fallback. `CONFORMANCE_TOKEN` is a Wrangler secret, and Hyperdrive
query caching is disabled before conformance and measurement runs.

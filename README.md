# Serialized DCB V1 5-endpoint runtime

This repository is the Cloudflare Workers implementation of the Serialized DCB
V1 runtime. It provides the durable allocation, tag, journal, materialized-view,
and repair components used to coordinate serialized event commits.

## Packages and starter

`dcb-core` provides Cloudflare-independent Serialized DCB definitions and domain algebra.
`dcb-domain` provides the runtime-free, schema-first DCB domain-authoring surface.
`dcb-client` provides the typed Serialized DCB V1 client and claim-ledger executor.
`dcb-runtime` provides the Cloudflare Durable Object and HTTP runtime.
`dcb-cloudflare` provides the optional composition helper that mounts Sekiban storage beside a caller's Worker.
`create-dcb` provides the CLI for creating a named Cloudflare starter project.
`templates/cloudflare-starter` is the booking-starter template used by `create-dcb` (not published to npm).

## Current scope

The runtime exposes five public V1 HTTP endpoints for commit, query, list-query,
tag-latest-sortable, and tag-state operations, plus the authenticated
`/operator/repair` surface. Its durable components provide:

- allocator-issued sortable IDs and durable allocation state;
- Tag and TagState Durable Objects for event/tag admission, heads, fences, and
  read state;
- one durable Journal record per commit attempt, compare-and-swap transitions,
  immutable terminal outcomes, owner epochs, and alarm-backed reconciliation;
- materialized-view catch-up with SafeWindow and unsafe-window fencing plus
  guarded retention and garbage collection; and
- per-tag operator repair that audits exclusions, persists repair work, and
  clears eligible fences without rewriting the original commit outcome.

The runtime is composed for Cloudflare Workers and is also exercised through
the local Workers/Vitest harness and the Postgres-backed development lanes.

## Operator repair CLI

`POST /operator/repair` is an authenticated operator-only surface. Start with
the mandatory dry run: `mode` defaults to `dry-run`, and a dry run makes no
durable writes. Use `mode: "execute"` only after reviewing that plan.

Repair auditing and unfencing are per tag, never an attempt-wide batch action.
A durable Tag outbox proves the repair was persisted for that tag; it is not a
downstream acknowledgement. `EXCLUDED_AUDITED` means the Tag head is ahead of
the repair SUID (`head > s`) and the exclusion was durably audited. It is a
permanent exclusion rather than a complete repair, so the original Journal
outcome remains `PARTIAL` and never becomes `COMPLETE`.

## Local development

Use Node.js 24 or newer.

```sh
npm install
docker compose up --wait postgres
npm run check
npm run build
```

`npm test` runs Vitest inside the Cloudflare Workers runtime using the
Workers Vitest integration and Miniflare. The suite exercises the Journal
against actual Durable Object storage, including concurrency, takeover, and
alarm behavior. `wrangler.jsonc` declares the Journal binding and SQLite
Durable Object migration; the GitHub Actions workflow runs lint, typecheck,
tests, and a Wrangler dry-run build.

## Meeting-room consumer sample

`samples/meeting-room` is the SDT-G14/G15/G29 consumer sample. Its domain is
authored with the public `@sekiban/dcb-domain` event/state/projector/command
surface and bridged with `toRuntimeDomain()`; the runtime's
projector/query registries remain private. A consumer composes its domain into
the runtime with `createRuntimeWorker({ domain, config })`. The sample exposes
its application command API and keeps raw V1 routes behind the authenticated
`/conformance/v1` lane. Its
framework-free `public/` frontend calls only the application command/read API
and uses the V1 sortable-id head to report pending, visible, conflict,
rejected, and partial outcomes honestly. Run `npm run deploy:g15` to deploy
the Worker and its static assets, then use `npm run e2e:g15 -- --base-url
<deployed-url> --report <path>` for redacted command-to-visible evidence.
Hyperdrive caching is disabled by the deployment script.

### Cloudflare-only quickstart (recommended)

`samples/meeting-room` is the **canonical Cloudflare getting-started sample**.
Operator path (create and configure both D1s → migrate both D1s → deploy → smoke → reset):
[`samples/meeting-room/docs/getting-started-cloudflare.md`](samples/meeting-room/docs/getting-started-cloudflare.md).

The named `cloudflare-only` sample composes the public runtime entrypoint with
one D1 binding for the PipelineStore (`D1`) and a separate D1 binding for the
materialized-view rows/checkpoints (`D1_MV`). Durable Objects and the outbox
Queue remain part of the composition; there is no Hyperdrive, Postgres, or
Cosmos binding in this variant. Its G16 reservation/room query UI reads the
`D1_MV` backing after the SafeWindow-aware catch-up worker runs.

```sh
npx wrangler d1 create sekiban-dcb-meeting-room-cloudflare-pipeline
npx wrangler d1 create sekiban-dcb-meeting-room-cloudflare-mv
# Replace the two REPLACE_WITH_CLOUDFLARE_ONLY_*_D1_ID values in
# samples/meeting-room/wrangler.cloudflare-only.jsonc with the returned IDs.

./samples/meeting-room/scripts/migrate-remote.sh
npx wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --keep-vars
```

Library / gate checks (optional before deploy):

```sh
npm run test:g20
npm run test:g20:gate
npm run build:g20
```

The PG sample remains available as the alternative via
`samples/meeting-room/wrangler.jsonc`; the library's default provider is still
Postgres and is never selected by an HTTP request. Before deploying that
variant, create a Hyperdrive config and replace
`REPLACE_WITH_SAMPLE_HYPERDRIVE_ID` in the same Wrangler file:

```sh
npx wrangler hyperdrive create sekiban-dcb-meeting-room --connection-string "<your PostgreSQL connection string>"
```

Set the non-secret
`SDT_SERVICE_ID` Wrangler var per deployment lifecycle (a new Durable Object
namespace requires a fresh service identity). The authenticated conformance
lane and the app-layer UI/e2e harness use that configured identity; internal
test headers are never forwarded by the sample.

G20 uses a candidate-commit protocol: the runtime, variant config, and this
quickstart switch are committed together, deployed and verified at one exact
candidate. Any later PR commit may change only redacted JSON evidence under
`docs/`; `npm run test:g20:candidate` machine-checks that boundary.

## License

This project is licensed under the Elastic License 2.0 (ELv2). See
[LICENSE](LICENSE) and [NOTICE](NOTICE).

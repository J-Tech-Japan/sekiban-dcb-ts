# Sekiban DCB for TypeScript

Sekiban DCB for TypeScript is a TypeScript event-sourcing runtime for Cloudflare Workers. It uses Durable Objects and Queues, stores events in Postgres by default or in opt-in D1 or the experimental Cosmos provider, and its generated starter uses two D1 databases. The [architecture guide](docs/architecture.md) explains the design.

Its logical event shape interoperates with C# Sekiban.Dcb for offline export and import. It has no shared physical layout or mixed live service. You can define a domain, accept serialized event commands, query read models, and start from the meeting-room example; the [logical-event migration guide](docs/migration-sekiban-dcb.md) explains this compatibility boundary.

## Quick start

Create a starter project from npm:

```sh
npx @sekiban/create-dcb my-booking-app
cd my-booking-app
npm install
```

The starter packages require Node.js 20 or newer. The generated project's README covers creating the two D1 databases, `npm run migrate`, and `npm run deploy`.

## Packages

The core, domain, client, and runtime packages (`@sekiban/dcb-core`, `@sekiban/dcb-domain`, `@sekiban/dcb-client`, and `@sekiban/dcb-runtime`) are released together as one matched set. `@sekiban/create-dcb` generates a starter project, and `@sekiban/dcb-cloudflare` is an optional composition helper for an existing Worker. The starter template lives in `packages/create-dcb/template`.

| Package | What it is for | When to use it |
| --- | --- | --- |
| [@sekiban/dcb-core](packages/dcb-core/README.md) | Cloudflare-independent event, tag, query, and read-model definitions. | Use it for shared contracts and domain primitives. |
| [@sekiban/dcb-domain](packages/dcb-domain/README.md) | Runtime-free, schema-first domain authoring. | Use it to define events, projectors, queries, and commands. |
| [@sekiban/dcb-client](packages/dcb-client/README.md) | Typed Serialized DCB V1 client and claim-ledger executor. | Use it when application code sends commands and reads state. |
| [@sekiban/dcb-runtime](packages/dcb-runtime/README.md) | Cloudflare Durable Object, Queue, storage, and HTTP runtime. | Use it to run the serialized event runtime. |
| [@sekiban/create-dcb](packages/create-dcb/README.md) | CLI that creates a named Cloudflare starter with a booking demo. | Use it for a new project created from npm. |
| [@sekiban/dcb-cloudflare](packages/dcb-cloudflare/README.md) | Optional helper that mounts Sekiban storage beside an existing Worker. | Use it when the application already owns its Worker routes and configuration. |

## Documentation

Choose a guide by the task you need to do.

### Getting started

| Guide | Description |
| --- | --- |
| [Cloudflare meeting-room sample](samples/meeting-room/docs/getting-started-cloudflare.md) | Create the sample's two D1 databases, migrate them, and deploy the Worker. |

### Concepts and contracts

| Guide | Description |
| --- | --- |
| [Architecture](docs/architecture.md) | Explains authority, derived views, acceptance, delivery, visibility, and repair. |
| [Commit tracing](docs/commit-tracing.md) | Describes the commit-trace authority, emitted observations, and verification. |
| [End-to-end sample proof](docs/end-to-end.md) | Describes the paced public-surface witness and its visibility evidence. |
| [Safe-lane scheduling](docs/safe-lane.md) | Explains queue kicks, cron catch-up, SafeWindow deadlines, and safe-head proof. |
| [Serialized write path](docs/write-path.md) | Defines durable acceptance, the response boundary, and derived delivery lanes. |

### Domain authoring and C# compatibility

| Guide | Description |
| --- | --- |
| [Domain authoring](docs/domain-authoring.md) | Maps event, projector, state, and command authoring between C# and TypeScript. |
| [Executor facade](docs/executor-facade.md) | Shows the application executor, its in-process and HTTP transports, and the portable snapshot workflow. |
| [Sekiban.Dcb logical-event migration](docs/migration-sekiban-dcb.md) | Defines the logical event record for offline export, import, and rebuild. |

### Storage, providers, and migration

| Guide | Description |
| --- | --- |
| [Experimental Cosmos layout](docs/cosmos-layout.md) | Records the separate Cosmos mapping and its provider-specific contract. |
| [Versioning contract](docs/versioning-contract.md) | Separates package, protocol, event, and read-side compatibility decisions. |
| [D1 PipelineStore](docs/d1-pipeline-store.md) | Describes the opt-in D1 provider, schema, limits, and guarded writes. |
| [D1 materialized views](docs/d1-materialized-views.md) | Describes the separate D1_MV backing, materializer, migrations, and catch-up. |
| [0.2.0 migration](docs/migration-0.1-to-0.2.md) | Explains the matched package release and its client read contract. |

### Operations and release

| Guide | Description |
| --- | --- |
| [Bootstrap import](docs/bootstrap-import.md) | Defines the provider-neutral dump validation, planning, and import authority transition. |
| [Bootstrap operator](docs/bootstrap-operations.md) | Documents the protected bootstrap operator routes and their actions. |
| [Release process](docs/release-process.md) | Describes the matched package release workflow and its authentication modes. |

## Meeting-room sample

The `samples/meeting-room` project is the canonical Cloudflare getting-started sample and a consumer of the public packages. It authors its domain with the public `@sekiban/dcb-domain` event, state, projector, and command surface and bridges it with `toRuntimeDomain()`; the runtime's projector and query registries stay private. A consumer composes its domain into the runtime with `createRuntimeWorker({ domain, config })`. The sample exposes its application command API and keeps the raw V1 protocol routes behind the authenticated `/conformance/v1` lane. Its framework-free `public/` frontend calls only the application command and read API and uses the V1 sortable-id head to report pending, visible, conflict, rejected, and partial outcomes honestly. Follow the [sample getting-started guide](samples/meeting-room/docs/getting-started-cloudflare.md) for the full setup.

The Cloudflare-only sample uses one D1 database for the PipelineStore and a separate D1 database for materialized-view rows and checkpoints. Durable Objects and the outbox Queue remain part of the composition. This variant has no Hyperdrive, Postgres, or experimental Cosmos binding. Its reservation and room query UI reads the materialized-view D1 database after the SafeWindow-aware catch-up worker runs.

```sh
npx wrangler d1 create sekiban-dcb-meeting-room-cloudflare-pipeline
npx wrangler d1 create sekiban-dcb-meeting-room-cloudflare-mv
./samples/meeting-room/scripts/migrate-remote.sh
npx wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --keep-vars
```

Replace the two D1 IDs in `samples/meeting-room/wrangler.cloudflare-only.jsonc` before migrating or deploying. The optional library and gate checks are listed in the development section.

The Postgres alternative uses `samples/meeting-room/wrangler.jsonc`. The library's default provider is still Postgres and is never selected by an HTTP request; this variant uses Hyperdrive to reach it. Create the Hyperdrive configuration and replace `REPLACE_WITH_SAMPLE_HYPERDRIVE_ID` before deploying:

```sh
npx wrangler hyperdrive create sekiban-dcb-meeting-room --connection-string "<your PostgreSQL connection string>"
```

Set the non-secret `SDT_SERVICE_ID` Wrangler variable for each deployment. A new Durable Object namespace needs a fresh service identity. The authenticated conformance lane and the application UI and end-to-end harness use that configured identity; the sample never forwards internal test headers. The deployment script disables Hyperdrive caching.

`npm run deploy:sample` deploys the Worker and its static assets; `npm run e2e:sample` then records redacted command-to-visible evidence against the deployed URL:

```sh
npm run deploy:sample
npm run e2e:sample -- --base-url <deployed-url> --report <path>
```

## Runtime surface and operations

The runtime exposes five public V1 HTTP endpoints: commit, query, list-query, tag-latest-sortable, and tag-state. It also exposes `POST /operator/repair`, an authenticated, operator-only repair surface.

Its durable components provide:

- allocator-issued sortable IDs and durable allocation state;
- Tag and TagState Durable Objects for event and tag admission, heads, fences, and read state;
- a retained Journal repair-workset and observation store; normal commits do not write it. Its records are evidence and operator-supplied repair input, not tag-append or terminal-write authority. See the [architecture component table](docs/architecture.md#component-ownership);
- materialized-view catch-up with SafeWindow and unsafe-window fencing, plus guarded retention and garbage collection;
- Queue-backed durable outbox delivery, acknowledgement, retry, and dead-letter recovery; and
- per-tag operator repair that audits exclusions, persists repair work, and clears eligible fences without rewriting the original commit outcome.

Start repair with the mandatory dry run. The `mode` defaults to `dry-run`, and a dry run makes no durable writes. Use `mode: "execute"` only after reviewing the plan. Repair auditing and unfencing are per tag, never an attempt-wide batch action. A durable Tag outbox proves that repair was persisted for that tag; it is not a downstream acknowledgement. `EXCLUDED_AUDITED` means the Tag head is ahead of the repair SUID (`head > s`) and the exclusion was durably audited. It is a permanent exclusion rather than a complete repair, so the original Journal outcome remains `PARTIAL` and never becomes `COMPLETE`.

## Developing this repository

Repository development uses Node.js 24 or newer. Install dependencies and run the local checks with the Postgres service available:

```sh
npm install
docker compose up --wait postgres
npm run check
npm run build
```

`npm test` runs Vitest inside the Cloudflare Workers runtime with the Workers Vitest integration and Miniflare. The suite exercises Durable Object storage and runtime behavior, including concurrency, takeover, and alarm behavior. `wrangler.jsonc` declares the Journal binding and SQLite Durable Object migration. Besides the local Workers and Vitest harness, the runtime is exercised through the Postgres-backed development lanes.

The [CI workflow](.github/workflows/ci.yml) runs the foundation and cheap manifest lanes for pull requests and pushes to main. The foundation lane runs lint, typecheck, and root tests; the cheap lane runs package, contract, starter, reference, and public-tree checks. The [full CI workflow](.github/workflows/ci-full.yml) runs all 11 manifest lanes weekly on the default branch and can be manually dispatched for a selected ref.

The Cloudflare-only composition checks are:

```sh
npm run test:cloudflare:composition
npm run test:cloudflare:composition:gate
npm run build:cloudflare:composition
```

## License

This project is licensed under the Elastic License 2.0 (ELv2). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

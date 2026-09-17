# Serialized DCB V1 5-endpoint runtime

This repository is the Cloudflare Workers implementation of the Serialized DCB
V1 runtime. The first delivery establishes the TypeScript project and the
per-commit-attempt Journal Durable Object that makes commit coordination
durable.

## Current scope

The Journal is an internal control component, not one of the five public V1
HTTP endpoints. It owns one durable record per commit attempt and provides:

- all-or-nothing admission of candidates, consistency tags, event tags, owner
  epoch `0`, initial state/version, and its first alarm;
- compare-and-swap state transitions, with terminal outcomes immutable and
  their response reconstructed from the durable Journal record;
- owner-epoch handoff before tag seals, plus the seal-and-full-requery absence
  barrier required before terminal failure or partial outcomes;
- a tested reconciliation table for allocator-vector and durable-record
  evidence; and
- alarm rearming with capped exponential backoff before reconciliation, so
  transient failures do not exhaust the platform retry budget.

Allocator, tag Durable Objects, public HTTP endpoints, fencing, repair, and
retention/GC are deliberately outside this first slice.

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
Operator path (migrate both D1s → deploy → smoke → reset):
[`samples/meeting-room/docs/getting-started-cloudflare.md`](samples/meeting-room/docs/getting-started-cloudflare.md).

The named `cloudflare-only` sample composes the public runtime entrypoint with
one D1 binding for the PipelineStore (`D1`) and a separate D1 binding for the
materialized-view rows/checkpoints (`D1_MV`). Durable Objects and the outbox
Queue remain part of the composition; there is no Hyperdrive, Postgres, or
Cosmos binding in this variant. Its G16 reservation/room query UI reads the
`D1_MV` backing after the SafeWindow-aware catch-up worker runs.

```sh
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
Postgres and is never selected by an HTTP request. Set the non-secret
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

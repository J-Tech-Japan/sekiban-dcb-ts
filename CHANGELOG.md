# Changelog

## Unreleased matched set 0.2.2

Package versions in this repository stay at 0.2.1. The matched set moves to
0.2.2 only in a later release-preparation change, after this fix and the
separate issue #287 interim fix are both merged. A later composition and
starter change will pass the request environment into the authorization
callback, document conditional `REPAIR_OPERATOR_TOKEN` setup for generated
projects, and keep the generated starter's current exact `/operator/*` 404
boundary. This changelog entry does not publish a package.

### @sekiban/dcb-runtime

- Shared bearer checks fail closed when a binding is missing, empty, or
  whitespace-only, and compare the full credential with one WebCrypto SHA-256
  digest.
- `/operator/bootstrap/*` and both meeting-room conformance gates keep exact
  configured bytes. Unconfigured bindings return 404. Configured missing or
  wrong credentials keep 404/403 for bootstrap and 403 for conformance.
- `POST /operator/repair` returns 404 when `REPAIR_OPERATOR_TOKEN` is not
  configured. Configured missing or wrong credentials remain 401. Non-POST
  remains 404.
- Incident maintenance still trims its configured token, returns 503 when that
  binding is unconfigured, and returns 401 for a missing or wrong credential.
- Denied bootstrap and repair requests are rejected before service-identity
  resolution and before downstream storage or Durable Object access.
- Cloudflare-only sample deployment wrappers require a protected
  `REPAIR_OPERATOR_TOKEN` file and send it to Wrangler on standard input.
  Optional conformance provisioning uses the same file rule. The sample
  wrapper's `--dry-run` and `-- --dry-run` forms bundle only and perform no
  remote action.

## @sekiban/dcb-domain 0.2.1 (matched release)

### @sekiban/dcb-core 0.2.1

- Republished as part of the matched set. The range since the current
  published baseline contains no intended public API change for core.

### @sekiban/dcb-domain 0.2.1

- Republished as the matched-set authority for the current domain release
  notes; no additional public API change is intended by this version bump.

### @sekiban/dcb-client 0.2.1

- Republished with core and domain pinned to the same exact matched version.
  No intended public API change is introduced by this release preparation.

### @sekiban/dcb-runtime 0.2.1

- Fails closed when an explicitly selected Cosmos provider has missing or
  incomplete bindings, before client or network access.
- Adds the authenticated incident lifecycle maintenance API and its
  compatibility-safe HTTP maintenance paths, plus the experimental explicitly
  selected Cosmos provider and checked layout contract.
- Covers service-scoped outbox handling, append-receipt tag-write results,
  bootstrap write permits, cross-epoch duplicate replay corrections, allocator
  and import safeguards, PostgreSQL logical-event APIs, and shard-rotation
  APIs with ordering guards.

### @sekiban/dcb-cloudflare 0.1.3

- Tightens mounted-prefix validation and supports explicitly mounted
  maintenance prefixes through `extraPrefixes`.

### @sekiban/create-dcb 0.1.3

- Includes D1 migration `0021_incident_lifecycle.sql` for D1 deployments that
  use incident maintenance and for the upgraded starter.
- Adds the inactive experimental Cosmos descriptor, standalone deployment
  runbook, checked deployment topology, and `deploy:check`.

The PostgreSQL tag-rebuild command remains a repository-only tool and is not a
feature shipped in any package tarball.

## @sekiban/create-dcb and @sekiban/dcb-cloudflare 0.1.2

- Update the package READMEs and the generated project's README; no code or
  template dependency change.

## @sekiban/dcb-domain 0.2.0 (matched with dcb-core and dcb-client)

- Publish the matched client/domain/core set with the G71 authority-backed read
  contract, list-only consistency lanes, and operation-specific read heads.
- Migration from 0.1.x is documented in `docs/migration-0.1-to-0.2.md`.

## @sekiban/dcb-domain 0.1.1

- Working post-W177 release-gate recovery version; no package was published by
  this checkpoint.

## @sekiban/dcb-domain 0.1.0

- First public release of the runtime-free, schema-first DCB domain authoring
  surface.
- Publishes the main authoring/runtime bridge and the `./testing` helpers with
  npm provenance support.

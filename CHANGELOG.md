# Changelog

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

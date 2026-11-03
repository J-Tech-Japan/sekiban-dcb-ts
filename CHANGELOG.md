# Changelog

## Unreleased

### @sekiban/dcb-core

- Use the conditional-commit protocol values on the active versioned route.
  Request and result DTOs, key normalization, canonicalization, fingerprint
  helpers, and closed parsers are unchanged. There is no type-contract change
  and no package version change.

- Export structural query contracts: `QueryJsonValue`, `QueryCodec`,
  `QueryRow`, `QueryProjection`, `QueryHandlerContext`, `QueryContract`,
  `ListQueryContract`, `ListQueryControls`, `QueryPageMetadata`, and
  `QueryPage`. Codecs are bidirectional `encode` / `decode` pairs. Contracts
  do not carry handlers. Nothing in this package executes a query.

### @sekiban/dcb-domain

- Add `defineQueryView`, `defineQuery`, and `defineListQuery` as an authoring
  preview. Params must be a strict Zod object and must not use a reserved
  control name. Definitions and contracts are frozen. Handlers stay
  synchronous and receive readonly inputs.
- Depend on the matched `@sekiban/dcb-core` `0.2.2` package. Domain source
  imports it only as types. `zod` stays pinned at `4.4.3`.
- `toRuntimeDomain()` compiles authored queries into frozen server
  registrations. A query-free domain still bridges an empty list. A source
  view that cannot be mapped throws `QUERY_SOURCE_INVALID`.
- Runtime composition rejects a malformed typed query on `domain.queries`,
  `config.queries`, or `config.queryDefinitions` before precedence. Ordinary
  id/version metadata is unchanged. `RuntimeWorkerConfig.maxScanRows` bounds
  executable scans and defaults to 1000.
- Refuse a codec output that cannot be copied into a detached value with
  `QUERY_CODEC_OUTPUT_UNCOPYABLE`. `Date`, `Map`, and `Set` outputs are
  admitted. A later internal execution copies them by value; it does not
  freeze them.
- Execute compiled queries on the server through the existing raw V1 routes
  for the in-memory checkpoint fallback, D1 pipeline checkpoints, D1
  materialized views, PostgreSQL, and Cosmos. Metadata-only queries keep the
  previous parameter guard and response envelopes. Public failures are
  `query_params_invalid`, `query_scan_limit_exceeded`, `query_row_invalid`,
  `query_result_invalid`, and `query_handler_failed`. The preview is
  unreleased and bound for `0.3.0`; it is not part of the published `0.2.x`
  packages. Release hardening and the `0.3.0` version bump are later changes.
  Handlers receive no database, network, environment, request, clock, paging,
  direction, consistency, waiting, or cancellation capability.

### @sekiban/dcb-client

- Activate built-in conditional commit on `SerializedDcbClient`,
  `createHttpTransport`, `createInProcessTransport`, and the `SekibanExecutor`
  facade. An explicit resend must send the same prepared value. There is no
  V1 fallback. A missing custom member still returns Unsupported. Package
  versions remain unchanged.

- Add typed `SekibanExecutor.query` and `listQuery` overloads beside the raw
  V1 overloads. `QueryCallOptions` is `waitForSortableUniqueId` and `signal`.
  List controls stay separate and map to `PageNumber`, `PageSize`,
  `NewestFirst`, and `consistency`. A request with string `queryType` and
  `queryParamsJson` stays raw. Transports stay raw.
- Local failures `query_params_encode_failed` (`invalid`, no status) and
  `query_result_decode_failed` (`unavailable`, no status) are fresh client
  errors. Recognized server codes are unchanged.
  `projection_ordering_quarantined` stays `transport` with status 503 and is
  not decoded. Package versions stay `0.2.2`. This client change is not in
  the published `0.2.2` packages, and `0.3.0` is not released.

### @sekiban/dcb-runtime

- Activate `POST /api/sekiban/serialized/conditional-commit` for fixed D1 and
  omitted-provider PostgreSQL. Cosmos and custom providers remain Unsupported.
  Downstream formats and versions are unchanged. Package versions remain
  unchanged.

- Document the existing V1 resend contract. An identical JSON body is a new
  operation. Consistency expectations are optimistic concurrency, not
  idempotency. A timeout, HTTP 504, or network or transport failure after
  dispatch leaves the outcome unknown and must be reconciled rather than
  blindly resent. Runtime, client, and wire semantics are unchanged. Package
  versions are unchanged.

## @sekiban/dcb-domain 0.2.2 (matched release)

### @sekiban/dcb-core 0.2.2

- Republished as part of the matched set. The range since the published
  baseline contains no intended public API change for core.

### @sekiban/dcb-domain 0.2.2

- Republished as the matched-set authority for the current domain release
  notes; no additional public API change is intended by this version bump.

### @sekiban/dcb-client 0.2.2

- Pins `@sekiban/dcb-core` and `@sekiban/dcb-domain` to the exact matched
  `0.2.2` release.
- Maps `query_params_unsupported` to the message "The selected query does not
  support these parameters." and classifies the code as `invalid`. The thrown
  `ClientError` shape is unchanged.

### @sekiban/dcb-runtime 0.2.2

- A scalar serialized query accepts only a parsed empty object. Any other
  parsed value is HTTP 400 `query_params_unsupported` with the message "The
  selected query does not support these parameters." The check runs after the
  query is resolved and before projector lookup, provider initialization, or a
  store read. A caller-supplied `{}` keeps the existing count result.
- A list query accepts only `PageNumber`, `PageSize`, `NewestFirst`, and
  `consistency`. An unknown own key receives the same 400 before provider or
  store work. Callers that previously sent ignored list keys must stop sending
  them. `waitForSortableUniqueId` stays an outer request field. Value checks
  and defaults are unchanged.
- `checkConfiguredBearer` fails closed when a binding is missing, empty, or
  whitespace-only. It hashes both complete credentials with SHA-256 and
  compares every digest byte without early exit.
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
- This `0.2.2` release does not include typed query handlers. The V1 response
  envelope is unchanged. The typed query API is defined in the repository and
  remains unreleased for `0.3.0`.

### @sekiban/dcb-cloudflare 0.1.4

- Authorization callbacks receive the request, environment, and execution
  context through `authorize(request, env, ctx)`. Callbacks that accept fewer
  arguments stay assignable.
- `forwardSerializedRoutes` is optional. Omitted or `true` keeps the five
  serialized paths. `false` vetoes each canonical built-in path before
  `extraPaths` and `extraPrefixes` are considered. Overlapping extras cannot
  restore a canonical path. A mount with `false` and no extras is valid.
  Non-overlapping extras still forward. A present non-boolean value fails
  fast.
- Depends on `@sekiban/dcb-runtime` `0.2.2` exactly.

### @sekiban/create-dcb 0.1.4

- Copies the offline validation core into the generated project. The starter
  imports only that local copy.
- The generated keyed room read returns the decoded room tag state and
  `lastSortedUniqueId`.
- `REPAIR_OPERATOR_TOKEN` source checks stay conditional. The token is optional
  until an `extraPath` or `extraPrefix` under `/operator`, or a direct runtime
  fetch export, is introduced. The unchanged project keeps `/operator/*`
  unmounted and does not require the token. `deploy:check` classifies those
  source shapes offline and does not verify remote state.
- Generated starters mount only the maintenance prefix under
  `/internal/sekiban`; application code calls the runtime in-process;
  `deploy:check` verifies this shape.
- `deploy:check` inspects the composition bound to the default export. More
  than one `composeHandlers` call, or a default export that is not that single
  const initializer, is an unresolved source shape before Wrangler. That
  binding's name may appear only on the const and on that one default export.
  Any other use, including a nested declaration of the same name, or a second
  default export, is an unresolved source shape before Wrangler.

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

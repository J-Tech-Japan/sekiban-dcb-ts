# Changelog

## @sekiban/dcb-domain 0.3.0 (matched release)

These package versions are released and available from npm.

### @sekiban/dcb-core 0.3.0

- Structural query shapes are part of this package: `QueryJsonValue`,
  `QueryCodec`, `QueryRow`, `QueryProjection`, `QueryHandlerContext`,
  `QueryContract`, `ListQueryContract`, `ListQueryControls`,
  `QueryPageMetadata`, and `QueryPage`. Codecs are bidirectional `encode` /
  `decode` pairs. Contracts do not carry handlers, and nothing in this package
  executes a query.
- Conditional-commit protocol shapes are on the active versioned route.
  Request and result DTOs, key normalization, canonicalization, fingerprint
  helpers, and closed parsers are unchanged.

### @sekiban/dcb-domain 0.3.0

- Author typed queries with `defineQueryView`, `defineQuery`, and
  `defineListQuery`. Params must be a strict Zod object and must not use a
  reserved control name. Definitions and contracts are frozen. Handlers stay
  synchronous, receive readonly inputs, and receive no database, network,
  environment, request, clock, paging, direction, consistency, waiting, or
  cancellation capability.
- Depend on the matched `@sekiban/dcb-core` `0.3.0` package. Domain source
  imports it only as types. `zod` stays pinned at `4.4.3`.
- `toRuntimeDomain()` compiles authored queries into frozen server
  registrations. A query-free domain still bridges an empty list. Compiled
  queries execute on the server through the existing raw V1 routes for the
  in-memory checkpoint fallback, D1 pipeline checkpoints, D1 materialized
  views, PostgreSQL, and Cosmos.
- `query_params_unsupported` is a caller correction. Do not blindly retry it.

### @sekiban/dcb-client 0.3.0

- Typed `query` and `listQuery` calls sit beside the raw V1 overloads. Paging
  and consistency stay controls rather than domain parameters. A request with
  string `queryType` and `queryParamsJson` stays raw.
- Fixed query error classification keeps the recognized server codes.
  `query_params_unsupported` is non-retryable caller correction.
- Built-in conditional commit is available on `SerializedDcbClient`,
  `createHttpTransport`, `createInProcessTransport`, and the `SekibanExecutor`
  facade. Prepare once and resend only that same held value after an
  explicitly retryable in-doubt result. There is no V1 fallback.
- Pins `@sekiban/dcb-core` and `@sekiban/dcb-domain` to the exact matched
  `0.3.0` release.

### @sekiban/dcb-runtime 0.3.0

- Query parameter validation rejects unsupported own keys as
  `query_params_unsupported` before provider or store work. Public failures
  use fixed safe messages and do not echo a thrown provider or handler
  message.
- The V1 resend contract is unchanged. An identical JSON body is a new
  operation. A timeout, HTTP 504, or network or transport failure after
  dispatch leaves the outcome unknown. V1 commit is not safe for a blind
  resend after an unknown outcome.
- `POST /api/sekiban/serialized/conditional-commit` admits one event and one
  tag. Fixed D1 and the built-in PostgreSQL composition support it. Cosmos and
  custom providers return Unsupported.
- An existing receipt is resolved before the import marker or bootstrap state.
  The same operation returns 200, a different operation returns 409, and a
  contradictory receipt returns 500. Only an absent receipt proceeds to those
  gates. A present import marker returns 501. Only no receipt plus no import
  marker consults bootstrap: `PLANNED`, `IMPORTING`, or `VERIFYING` returns
  retryable 503, and `READY`, `FAILED`, or any other value returns 501.

### @sekiban/dcb-cloudflare 0.2.0

- Composition forwarding covers the already-merged public surface, including
  the conditional route when serialized forwarding stays on.
- Depends on `@sekiban/dcb-runtime` `0.3.0` exactly. This helper version is
  released and available from npm.

### @sekiban/create-dcb 0.2.0

- Generated starters pin the matched set at `0.3.0` and permit
  `@sekiban/dcb-cloudflare` from `^0.2.0`.
- The generated offline deployment check stays in the starter. It does not
  create Cloudflare resources.
- This creator version is released and available from npm.

### Migration from matched 0.2.2 and helper/creator 0.1.4

- Define queries with the authored query definitions and move callers to the
  typed `query` and `listQuery` methods. Keep paging and consistency in the
  controls argument.
- Treat `query_params_unsupported` as a request bug. Correct the parameters
  the selected query accepts, and do not blindly retry that code.
- Adopt conditional commit only when the caller can prepare once, hold that
  prepared value, and resend the same value after an explicitly retryable
  in-doubt result. Never fall back from conditional commit to V1.
- V1 commit is still not safe for a blind resend after an unknown outcome.
  Reconcile fresh authoritative state before issuing a new operation.

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

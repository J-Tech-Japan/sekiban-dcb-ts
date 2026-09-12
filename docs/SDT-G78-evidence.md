# SDT-G78 evidence

This document is the evidence record for issue #157. G78 moves ownership of
the runtime cloud transport out of `@sekiban/dcb-client`, pins the cloud
request shape, and preserves the public error distinctions at the boundary
this repository owns.

## Scope and evidence boundary

The implementation branch is `claude/sdt-g78-implementation-w274`, cut from
`origin/main` at `994a44c3560e617cc82886336132574630d60de2`. The issue was
claimed with the GitHub-only worker protocol before source work. The source
package remains `@sekiban/dcb-client@0.2.0`; local HTTP and in-process
transports are unchanged.

The designated downstream identity is the runtime named export
`createSekibanCloudTransport` from `@sekiban/cloud-client@0.2.0`. The
downstream package is a contract target, not an observed package: this
repository does not claim that it is implemented, published, or runtime
conformant. The packed consumer below uses a declaration-only deterministic
fixture to prove only the migration import and shared type boundary. Fetch
wrapper behavior and publication remain a separately gated SekibanCloud
deliverable.

## AC1 — ownership move and type-only options

The runtime `createSekibanCloudTransport` implementation and its cloud-specific
catch have been removed from `packages/dcb-client/src/executor.ts`. The package
root no longer exports a callable cloud factory. `SekibanCloudTransportOptions`
is retained in `packages/dcb-client/src/cloud-contract.ts` and re-exported from
`src/index.ts` with `export type`; its canonical keys remain
`BaseUrl`, `ServiceId`, `CredentialId`, and `CredentialSecret`, with the
pre-existing optional `fetch` test hook. `createHttpTransport` and
`createInProcessTransport` remain owned here.

`node scripts/g78-ownership-guard.mjs --self-test` checks the source and built
root. Its self-test mutates the root into a callable cloud export and the guard
turns red. The focused root test also checks at runtime that
`createSekibanCloudTransport` is absent while the options type and local
transport factories remain available.

## AC2 — scoped cloud URL and header contract

The golden fixture is `test/fixtures/g78-cloud-transport-contract.json`, with
the request builder and validator in `test/helpers/g78-cloud-contract.ts`.
For each operation, the required URL is:

`trimTrailingSlash(BaseUrl) + /api/ + ServiceId + /sekiban/serialized/ + operation`

The required header is `X-Sekiban-Service-Id` with exactly the same
`ServiceId`. The five pinned operations are `commit`, `tag-state`,
`tag-latest-sortable`, `query`, and `list-query`. The validator rejects an
unscoped `/api/sekiban/serialized/*` route, a path/header disagreement, and
any route outside the golden operation set. The fixture has no path callback
or custom fetch rewrite surface.

The focused test passes all five operations and directly rejects both invalid
shapes. `node scripts/g78-cloud-contract-mutation-runner.mjs --self-test`
applies two behavioral fixture mutations and restores the bytes:

| mutant | expected result |
| --- | --- |
| service header disagrees with path | red: named scoped-contract assertion fails |
| unscoped route accepted | red: named scoped-contract assertion fails |

This is a contract fixture proof. It is not evidence that the downstream
cloud-client runtime has been published or executed.

## AC3/AC4 error classification

Classification is tested through public `createSekibanExecutor` and
`ClaimLedgerExecutor` boundaries against conforming injected transports. The
three actionable classes are distinct:

| class | caller action |
| --- | --- |
| caller abort | stop automatic work; an after-dispatch abort still needs reconciliation because it is not proof of refusal |
| deadline/unknown outcome | retry a read only under a renewed budget; reconcile a command while retaining its logical operation identity, never blindly reissue |
| definite refusal | fix credentials/input/scope or reread and recompute a conflict; do not infer definiteness from an arbitrary 5xx |
| malformed/unknown response | do not trust the response or treat it as absence; inspect or reconcile rather than blindly retry |

The source-derived classification table is:

| code | class | dispatch/action basis | source derivation |
| --- | --- | --- | --- |
| `aborted` | caller-abort | caller cancellation; stop, and reconcile if dispatched | `executor.ts` read boundary; `index.ts` controlled execution |
| `assert_empty_failed` | definite-refusal | local state assertion rejected before commit | `index.ts` `ClaimLedgerExecutor` |
| `claim_not_in_candidate_tags` | definite-refusal | consistency claim does not cover a candidate | `index.ts` `preflightCommit` |
| `command_rejected` | definite-refusal | authored command rejected without a commit | `executor.ts`/`index.ts` result mapping |
| `consistency_conflict` | definite-refusal | server conflict; reread and recompute | `executor.ts`/`index.ts` commit mapping |
| `duplicate_consistency_entry` | definite-refusal | malformed commit consistency input | `index.ts` `preflightCommit` |
| `incoherent_read_snapshot` | malformed/unknown | identity/head observations cannot be trusted | `executor.ts`/`index.ts` normalization |
| `invalid_command_input` | definite-refusal | authored input validation failed before dispatch | `executor.ts` result mapping |
| `invalid_command_result` | malformed/unknown | command did not return a trusted decision | `index.ts` decision validation |
| `invalid_consistency` | definite-refusal | list-query lane value is invalid | `executor.ts` request validation |
| `invalid_query_request` | definite-refusal | list-query request JSON is malformed | `executor.ts` request validation |
| `invalid_query_response` | malformed/unknown | query response shape is not trusted | `executor.ts` response validation |
| `invalid_read_snapshot` | malformed/unknown | tag-state/authority response shape is not trusted | `executor.ts`/`index.ts` normalization |
| `http_error` | malformed/unknown | default non-2xx code; status must be inspected | `executor.ts`/`index.ts` HTTP normalization |
| `read_unavailable` | deadline/unknown | bounded authority/frontier read did not converge | `executor.ts` bounded read |
| `scope.mismatch` | definite-refusal | executor and transport scopes conflict | `executor.ts` executor guard |
| `timeout` | deadline/unknown | caller budget expired; reconcile commands | `index.ts` controlled execution |
| `transport` | malformed/unknown | transport failed without a definite refusal | `executor.ts`/`index.ts` boundary |
| `unknown_outcome` | deadline/unknown | commit acknowledgement is not certain; reconcile | `executor.ts`/`index.ts` result mapping |
| `unsupported_capability` | definite-refusal | required authority capability is absent | `executor.ts` capability guard |
| `unsupported_consistency_mode` | definite-refusal | consistency supplied outside list-query | `executor.ts` lane guard |

The row set is not copied from prose: `scripts/g78-error-classification-guard.mjs`
derives `new ClientError(...)` codes, result `code` literals, and HTTP/unknown
defaults from every dcb-client source file, then requires a row for each and
rejects an injected future code in its self-test. This source has no
`credential.rejected` cloud-wrapper implementation after AC1; that code is a
downstream contract detail, not a client-raised code here.

The public focused suite proves caller abort before dispatch, abort after
dispatch, deadline, definite refusal, unknown outcome, malformed response,
and a typed error object from another package copy. The cross-copy case uses
`code`, `status`, and `partial`, not `instanceof`; the public error contains
only sanitized detail and excludes the synthetic credential secret.

`node scripts/g78-error-classification-mutation-runner.mjs --self-test`
changes the abort classification to `transport`. The named public
classification test turns red, with a structured assertion failure, and the
source is restored. The cloud-client wrapper's fetch-level classify-before-
sanitize behavior remains outside this repository's implementation claim;
this repository proves preservation of classifications emitted by a
conforming injected transport.

## AC5 — 0.2.0 migration contract

The matched set remains `@sekiban/dcb-core@0.2.0`,
`@sekiban/dcb-domain@0.2.0`, and `@sekiban/dcb-client@0.2.0`. Removing the
callable root export is a released-surface break requiring migration. The
replacement identity is explicitly `createSekibanCloudTransport` from
`@sekiban/cloud-client@0.2.0`, but the downstream package is not claimed to
exist or be published.

`scripts/g78-packed-consumer-check.mjs` packs the three local packages and a
declaration-only `@sekiban/cloud-client@0.2.0` fixture into a clean temporary
consumer. The consumer imports the named root export, assigns the shared
`SekibanCloudTransportOptions`, and checks the returned
`SerializedDcbTransport` boundary under Node16 and Bundler TypeScript module
resolution. This is compile-only evidence: the fixture has no runtime
implementation, no fetch behavior is executed, and no npm publication or
credential handling occurs.

The matched 0.x rationale is unchanged: `^0.2.0` permits compatible `0.2.x`
updates but not `0.3.0`; `0.1.x` is not a substitute. Pin all three local
packages to the same exact version when reproducibility matters.

## AC6 evidence inventory

| obligation | durable proof |
| --- | --- |
| ownership move | `scripts/g78-ownership-guard.mjs`, focused root test, source diff |
| scoped URL/header | JSON golden fixture, focused five-operation test, two red behavioral mutants |
| classification/action map | source-derived guard, focused public boundary tests, table above |
| classify-before-sanitize boundary | typed cross-copy sanitized fixture with synthetic-secret exclusion; downstream fetch wrapper explicitly not claimed |
| migration | clean packed compile-only consumer for `@sekiban/cloud-client@0.2.0` |
| unchanged adjacent behavior | existing G57/local transport tests and package build; no local transport path changes |

Missing evidence is not presented as collected: downstream runtime execution,
fetch-wrapper behavior, and npm publication remain unobserved and out of this
PR's claim.

## AC7 process and verification

The issue claim preceded source changes on the dedicated branch. The planned
PR will target `main` and use `Closes #157`. No Full CI, workflow dispatch,
npm publication, release preparation, G74, or G77 work is part of this unit.

Final exact-head CI and review receipts will be appended here after the PR is
created and the ordinary PR workflow reaches its terminal state. Historical
receipts, if any, will remain labelled historical rather than being reused as
current-head evidence.

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
| `authority_unavailable` | malformed/unknown | legacy G71 authority wire code is safe-listed; do not infer absence | G71 public wire contract; `errors.ts` finite safe-code set |
| `assert_empty_failed` | definite-refusal | local state assertion rejected before commit | `index.ts` `ClaimLedgerExecutor` |
| `claim_not_in_candidate_tags` | definite-refusal | consistency claim does not cover a candidate | `index.ts` `preflightCommit` |
| `command_rejected` | definite-refusal | authored command rejected without a commit | `executor.ts`/`index.ts` result mapping |
| `consistency_conflict` | definite-refusal | server conflict; reread and recompute | `executor.ts`/`index.ts` commit mapping |
| `credential.rejected` | definite-refusal | downstream credential refusal; keep credential response details private | finite sanitizer code set in `errors.ts` |
| `domain_authoring_error` | definite-refusal | a handler or domain-layer `DomainAuthoringError` (for example `SNAPSHOT_STATE_INVALID`); the authoring code is in `error`; fix the command or domain authoring, nothing was sent | `executor.ts` result mapping (SDT-G86) |
| `duplicate_consistency_entry` | definite-refusal | malformed commit consistency input | `index.ts` `preflightCommit` |
| `incoherent_read_snapshot` | malformed/unknown | identity/head observations cannot be trusted | `executor.ts`/`index.ts` normalization |
| `invalid_command_input` | definite-refusal | authored input validation failed before dispatch | `executor.ts` result mapping |
| `invalid_command_result` | malformed/unknown | command did not return a trusted decision | `index.ts` decision validation |
| `invalid_consistency` | definite-refusal | list-query lane value is invalid | `executor.ts` request validation |
| `invalid_execute_options` | definite-refusal | executor options are invalid (maxConflictRetries is not a non-negative safe integer); refused before any read or commit | `executor.ts` result mapping (SDT-G88) |
| `invalid_query_request` | definite-refusal | list-query request JSON is malformed | `executor.ts` request validation |
| `invalid_query_response` | malformed/unknown | query response shape is not trusted | `executor.ts` response validation |
| `invalid_read_snapshot` | malformed/unknown | tag-state/authority response shape is not trusted | `executor.ts`/`index.ts` normalization |
| `http_error` | malformed/unknown | default non-2xx code; status must be inspected | `executor.ts`/`index.ts` HTTP normalization |
| `partial_write` | definite-refusal | retain only validated write facts; reconcile and never blindly retry | `errors.ts` sanitizer plus commit mapping |
| `projection_unavailable` | deadline/unknown | renew the read budget before retrying projection work | `errors.ts` status fallback plus result mapping |
| `read_unavailable` | deadline/unknown | bounded authority/frontier read did not converge | `executor.ts` bounded read |
| `scope.mismatch` | definite-refusal | executor and transport scopes conflict | `executor.ts` executor guard |
| `timeout` | deadline/unknown | caller budget expired; reconcile commands | `index.ts` controlled execution |
| `transport` | malformed/unknown | transport failed without a definite refusal | `executor.ts`/`index.ts` boundary |
| `unknown_outcome` | deadline/unknown | commit acknowledgement is not certain; reconcile | `executor.ts`/`index.ts` result mapping |
| `unsupported_capability` | definite-refusal | required authority capability is absent | `executor.ts` capability guard |
| `unsupported_consistency_mode` | definite-refusal | consistency supplied outside list-query | `executor.ts` lane guard |

The row set is not copied from prose: `scripts/g78-error-classification-guard.mjs`
derives the finite safe-message code set, `new ClientError(...)` codes, result
`code` literals, and HTTP/unknown defaults from every dcb-client source file,
then requires a row for each and rejects an injected future code in its
self-test. `authority_unavailable` is retained as the finite legacy G71
authority wire code, but its transport message is replaced with a canonical
safe message. `credential.rejected` is included as a documented downstream
contract code even though no cloud wrapper implementation remains in this
package after AC1.

The public focused suite proves caller abort before dispatch, abort after
dispatch, deadline, definite refusal, unknown outcome, malformed response,
and sanitation of same-package, structural cross-copy, and HTTP-shaped
transport errors. Distinct synthetic secrets are placed in the foreign
message, cause, headers, partial object, and extension fields; the assertions
inspect `message`, `cause`, `headers`, `partial`, `code`, `status`, own public
name, and JSON output. The public error is a fresh canonical error with no
foreign detail. A separate command proof keeps only validated partial-write
facts, remains `kind: "partial"`, and does not create a retryable outcome.

`node scripts/g78-error-classification-mutation-runner.mjs --self-test`
changes the abort classification to `transport`. The named public
classification test turns red, with a structured assertion failure, and the
source is restored. The cloud-client wrapper's fetch-level classify-before-
sanitize behavior remains outside this repository's implementation claim;
this repository proves preservation of classifications emitted by a
conforming injected transport.

`node scripts/g78-error-sanitization-mutation-runner.mjs --self-test` verifies
unique source anchors and rejects green, missing-report, signal, spawn,
timeout, setup/import, and unrelated-failure receipts. Its focused behavioral
run records three red mutants: preserving the raw cause, preserving the raw
message, and preserving the raw partial object. Each has a clean status-1
process, one failed named public assertion, and no unrelated failure; each
source file is restored after mutation. Together with the retained abort
class-collapse mutant, this is the four-mutant AC4 proof.

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
| classify-before-sanitize boundary | same-package, structural cross-copy and HTTP-shaped fixtures inspect all public properties; foreign command partial-write keeps validated facts; three sanitation mutants plus retained abort class-collapse mutant are red |
| migration | clean packed compile-only consumer for `@sekiban/cloud-client@0.2.0` |
| unchanged adjacent behavior | existing G57/local transport tests and package build; no local transport path changes |

Missing evidence is not presented as collected: downstream runtime execution,
fetch-wrapper behavior, and npm publication remain unobserved and out of this
PR's claim.

## AC7 process and verification

The issue claim preceded source changes on the dedicated branch. PR #175
targets `main` and uses `Closes #157`. The initial implementation head was
`7933373be77e5bbf2ddf7ca6f78829f6fcc96db5`, based on
`994a44c3560e617cc82886336132574630d60de2`. No Full CI, workflow dispatch,
npm publication, release preparation, G74, or G77 work is part of this unit.

The first ordinary PR workflow at the initial head was run
`34723313704`:

| receipt | result | exact first error |
| --- | --- | --- |
| `ci-pr-cheap` job `103632976081` | failed | the G40 allowlist still expected 132 manifest commands while the reviewed G78 manifest contained 133 |
| `ci-foundation` job `103632976207` | failed | unchanged `test/commit.spec.ts:556` inherited Vitest 5,000 ms timeout; 99 files and 839 tests passed, with one skipped, before the timeout |
| `verify` job `103634192360` | failed by dependency | it did not add an independent G78 failure |

The same push's automatic release-preflight `34723313753` completed
successfully. The cheap-lane failure was a bounded G40 inventory consequence
of the intended foundation-g78 manifest command, so this repair updates only
the reviewed allowlist counts and digests; it does not alter the G40 guard or
any test. The foundation timeout is an unchanged baseline failure and is not
calibrated or masked by G78.

The G40 allowlist repair was committed as `582a1344b7786d3558fd5ae16412c05c69e62fc5`,
and the packed-consumer cache portability repair was committed as
`ddb66c70876fbcce6fc4d20be5f0db713e4824cf`. The exact-head hosted receipts
are recorded without replacing either earlier attempt:

| head | ordinary PR workflow | terminal jobs | paired release preflight |
| --- | --- | --- | --- |
| `7933373be77e5bbf2ddf7ca6f78829f6fcc96db5` | [34723313704](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34723313704), failure | `ci-pr-cheap` 103632976081 failed on the intended G78 manifest command not yet being in the G40 allowlist; `ci-foundation` 103632976207 failed at unchanged `test/commit.spec.ts:556` inherited 5,000 ms timeout; `verify` 103634192360 failed by dependency | [34723313753](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34723313753), success |
| `582a1344b7786d3558fd5ae16412c05c69e62fc5` | [34724022299](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34724022299), failure | `ci-pr-cheap` 103634871199 passed; `ci-foundation` 103634871282 exposed the in-scope packed-consumer default cache defect (`EACCES` creating `/private`); `verify` 103636669770 failed by dependency | [34724022294](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34724022294), success |
| `ddb66c70876fbcce6fc4d20be5f0db713e4824cf` | [34724802064](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34724802064), success | `ci-pr-cheap` 103636954489 success (15m04s); `ci-foundation` 103636954610 success (8m19s); `verify` 103638713620 success (5s) | [34724802054](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34724802054), success; job 103636954395 |

The final row is the current exact-head verification: head
`ddb66c70876fbcce6fc4d20be5f0db713e4824cf`, base
`994a44c3560e617cc82886336132574630d60de2`, branch
`claude/sdt-g78-implementation-w274`, PR #175. The final workflow was an
ordinary pull-request run; no manual dispatch, Full CI, rerun, publication,
release preparation, G74, or G77 work was used. The earlier rows remain
historical receipts and are not renamed or reused as final evidence.

# SDT-G28 oracle map

This map is the implementation-to-contract index for issue #62. The runtime
package remains the owner of admission, allocation, and durable identity; the
new package owns authoring, session, parse, bridge, and pure test semantics.

| AC | Contract | Oracle and mutation isolation | Evidence |
| --- | --- | --- | --- |
| 1 | `@sekiban/dcb-domain` has exactly the `zod` dependency and no runtime/host imports or ambient clock/network globals. | The boundary checker and package-scoped ESLint restrictions scan source, direct/transitive/path-alias/deep-relative/dynamic-import fixtures, forbidden globals, and `npm pack` contents. Each gate has an expected-red environment probe. | `scripts/dcb-domain-boundary-check.mjs`, `eslint.config.mjs`, `packages/dcb-domain/boundary-fixtures`, `.github/workflows/ci.yml` |
| 2 | Schema-first events require tags, default to version 1, expose `EventOf`, and reject invalid construction. | Dedicated typecheck fixtures pin missing-schema, missing-tags, and unbranded-payload diagnostics. Runtime tests cover parse, tag derivation, explicit v2 identity, union parse, and invalid payload rejection. | `packages/dcb-domain/src/event.ts`, `packages/dcb-domain/typecheck-fixtures`, `test/dcb-domain.spec.ts` |
| 3 | Discriminated state unions, pure validate/evolve modules, family-bound projectors, handler coverage, source/view consistency, and unique IDs. | Zod discriminated-union construction and the unique family invariant make a wrong-family read an unused-`@ts-expect-error` failure. Registration exercises missing handlers, duplicate identities, source mismatch, and event coverage. | `packages/dcb-domain/src/state.ts`, `src/domain.ts`, `test/dcb-domain.spec.ts` |
| 4 | Commands have a bounded declared read set and narrow async context; append derives tags once; only `done|none|reject` constructors create terminal decisions. | Session propagation spy observes one canonical tag value at staged-log, eligible-cell, claim/candidate-preflight, and sealed-envelope points. Dynamic reads throw `UNDECLARED_DYNAMIC_READ`; reject kinds use the V1 error-code table. | `packages/dcb-domain/src/command.ts`, `src/session.ts`, `test/dcb-domain.spec.ts` |
| 5 | Eligible cells require tag membership, subscription, and family match; late reads replay the staged log; stored tags remain authoritative. | The session suite covers subscribed and unsubscribed projectors, wrong families, multi-tag propagation, late replay, and a v1-derived stored-tag replay under a changed tag registry. Each one-point substitution has its own spy assertion. | `packages/dcb-domain/src/session.ts`, `test/dcb-domain.spec.ts` |
| 6 | Session lifecycle is `OPEN -> SEALED(done)` or `DISCARDED`; tentative events are committed only as one done envelope. | Discard tests assert zero commit-port calls and empty staged work. Lifecycle guards reject append-after-seal and repeated terminal operations; throw/reject/none use the discard path. | `packages/dcb-domain/src/session.ts`, `test/dcb-domain.spec.ts` |
| 7 | Conflict retry uses a fresh session and one executor-captured now; identity allocation is outside the portable decision log. | The retry fixture asserts new attempt state, empty prior overlay, identical fixed now, no eventId/SUID in the candidate, and no allocator/admission port in the discarded attempt. Unknown outcomes are not blindly retried. | `packages/dcb-domain/src/session.ts`, `src/types.ts`, `test/dcb-domain.spec.ts` |
| 8 | Per-tag snapshots and claims are coherent across projectors; read-only tags participate in the candidate; portable snapshot/decision-log contracts are serializable. | The session tracks heads by tag, detects cross-projector head disagreement, includes read-only and exists claims in candidate tags, and exposes portable snapshot serialization plus adapter-neutral command results. | `packages/dcb-domain/src/session.ts`, `src/types.ts`, `test/dcb-domain.spec.ts` |
| 9 | `toRuntimeDomain()` normalizes authoring and legacy v1 definitions into the existing runtime registry without changing V1 wire shape. | Bridge tests run a bridged projector through `composeRuntime`, verify canonical `name:version`, reject duplicate identity, and retain the old runtime definition path. No reverse runtime import exists in package source. | `packages/dcb-domain/src/bridge.ts`, `packages/dcb-runtime/src/composition.ts`, `test/dcb-domain.spec.ts` |
| 10 | HTTP, queue, stored-event, WASM restore, and external-query inputs parse once and fail closed. | Each parser brands its output; boundary-specific `BoundaryParseError` identifies the exact bypass. The WASM decoder rejects malformed bytes, and source casts are rejected by the boundary gate. | `packages/dcb-domain/src/parse.ts`, `scripts/dcb-domain-boundary-check.mjs`, `test/dcb-domain.spec.ts` |
| 11 | The testing subpath provides pure given/when/then and evolve-table helpers, including an internal v2 exercise domain. | `test/dcb-domain.spec.ts` runs both a command decision and an evolve table through `@sekiban/dcb-domain/testing`; the package boundary rejects runtime imports from the kit. | `packages/dcb-domain/src/testing.ts`, `test/dcb-domain.spec.ts` |
| 12 | R33-3 #1/#2/#7/business-#10 closure gates preserve the two-clock separation. | The boundary forced-red probe catches clock reintroduction; retry tests catch per-attempt now recapture; branded decision-log types and absence of allocation identity catch SUID/clock coupling. | `.github/workflows/ci.yml`, `test/dcb-domain.spec.ts`, `packages/dcb-domain/src/types.ts` |
| 13 | G13–G27 regressions stay green and the new lanes are reachable; C/R evidence is non-self-referential. | CI runs compile-fail, package boundary, authoring/session/bridge/parse, and explicit forced-red probes. `scripts/g20-candidate-check.mjs` validates G28 evidence digests and one exact retained-list append after C. | `.github/workflows/ci.yml`, `scripts/g20-candidate-check.mjs`, `docs/SDT-G28-deploy-evidence.json` |

## Guard-isolation matrix

Every mutation is recorded against the same sequence: baseline pass → upstream
guard observed passing → target branch/port reached → exact typed outcome or
finding → downstream call count zero. The package tests keep those observations
at the boundary (typecheck diagnostics, propagation spy, snapshot/commit spy,
and bridge registry), rather than treating a later state snapshot as proof of
which guard ran.

## Candidate protocol

Final candidate C contains the package, runtime bridge, CI, tests, README, this
map, PR body, and an evidence placeholder. The evidence records C's SHA and
tree digests. Bookkeeping commit R updates only
`docs/SDT-G28-deploy-evidence.json` and appends C once to the retained-candidate
fetch list in `.github/workflows/ci.yml`; it does not change implementation or
the oracle map. No internal/test header forwarding or secret is included.

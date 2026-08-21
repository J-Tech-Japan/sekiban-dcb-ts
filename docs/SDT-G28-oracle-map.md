# SDT-G28 oracle map

This map is the implementation-to-contract index for issue #62. The runtime
package remains the owner of admission, allocation, and durable identity; the
new package owns authoring, session, parse, bridge, and pure test semantics.

| AC | Contract | Oracle and mutation isolation | Evidence |
| --- | --- | --- | --- |
| 1 | `@sekiban/dcb-domain` has exactly the `zod` dependency and no runtime/host imports or ambient clock/network globals. | The boundary checker has three independently invocable probes (`source`, `negative-fixtures`, `package-manifest`) with selected-gate completion attestation, an aggregate coverage attestation, and one forced-red CI proof per probe; deleting a gate call leaves its own probe red. | `scripts/dcb-domain-boundary-check.mjs`, `eslint.config.mjs`, `packages/dcb-domain/boundary-fixtures`, `.github/workflows/ci.yml` |
| 2 | Schema-first events require tags, default to version 1, expose `EventOf`, and reject invalid construction. | Dedicated typecheck fixtures pin missing-schema, missing-tags, and unbranded-payload diagnostics. Runtime tests cover parse, tag derivation, explicit v2 identity, union parse, and invalid payload rejection. | `packages/dcb-domain/src/event.ts`, `packages/dcb-domain/typecheck-fixtures`, `test/dcb-domain.spec.ts` |
| 3 | Discriminated state unions, pure validate/evolve modules, family-bound projectors, handler coverage, source/view consistency, and unique IDs. | Zod discriminated-union construction and the unique family invariant make a wrong-family read an unused-`@ts-expect-error` failure. Registration exercises missing handlers, duplicate identities, source mismatch, and event coverage. | `packages/dcb-domain/src/state.ts`, `src/domain.ts`, `test/dcb-domain.spec.ts` |
| 4 | Commands have a bounded declared read set and narrow async context; append derives tags once; only `done|none|reject` constructors create terminal decisions. | Propagation observations assert the canonical upstream tag objects, not point names; read-only A + append B, two-event sealing, 0/1/N discard, and each of the four propagation points have separate exact-value assertions. | `packages/dcb-domain/src/command.ts`, `src/session.ts`, `test/dcb-domain.spec.ts` |
| 5 | Eligible cells require tag membership, subscription, and family match; late reads replay the staged log; stored tags remain authoritative. | A 2x2 eager/late fixture separates exact tag membership, subscribed/unsubscribed event type, and wrong family. A stored v1→v2 multi-tag fixture mutates the live deriver after append and proves late replay uses the staged tags. | `packages/dcb-domain/src/session.ts`, `test/dcb-domain.spec.ts` |
| 6 | Session lifecycle is `OPEN -> SEALED(done)` or `DISCARDED`; tentative events are committed only as one done envelope. | Discard tests assert zero commit-port calls and empty staged work. Lifecycle guards reject append-after-seal and repeated terminal operations; throw/reject/none use the discard path. | `packages/dcb-domain/src/session.ts`, `test/dcb-domain.spec.ts` |
| 7 | Conflict retry uses a fresh session and one executor-captured now; identity allocation is outside the portable decision log. | Changing-clock retry asserts one clock capture, identical attempt times, no eventId/SUID in `DecisionLog`, and the bridge conflict barrier keeps all write ports at zero on attempt one. | `packages/dcb-domain/src/session.ts`, `src/types.ts`, `src/bridge.ts`, `test/dcb-domain.spec.ts`, `packages/dcb-domain/diagnostic-fixtures` |
| 8 | Per-tag snapshots and claims are coherent across projectors; read-only tags participate in the candidate; portable snapshot/decision-log contracts are serializable. | The session tracks heads by tag, detects cross-projector head disagreement, includes read-only and exists claims in candidate tags, and exposes portable snapshot serialization plus adapter-neutral command results. | `packages/dcb-domain/src/session.ts`, `src/types.ts`, `test/dcb-domain.spec.ts` |
| 9 | `toRuntimeDomain()` normalizes authoring and legacy v1 definitions into the existing runtime registry without changing V1 wire shape. | `toRuntimeDomain()` returns a real command adapter with `committed|noop|rejected` outcomes. The integration fixture proves read-only conflict barrier → admission → one allocation vector → commit, same-candidate unknown reconcile, and G27 provenance/canonical identity. | `packages/dcb-domain/src/bridge.ts`, `packages/dcb-runtime/src/composition.ts`, `test/dcb-domain.spec.ts` |
| 10 | HTTP, queue, stored-event, WASM restore, and external-query inputs parse once and fail closed. | Each boundary receives an invalid schema value and asserts its own exact finding (`<boundary>-parse`) before a downstream call; WASM schema bypass and cross-boundary branded-value reuse are covered separately. | `packages/dcb-domain/src/parse.ts`, `scripts/dcb-domain-boundary-check.mjs`, `test/dcb-domain.spec.ts` |
| 11 | The testing subpath provides pure given/when/then and evolve-table helpers, including an internal v2 exercise domain. | `test/dcb-domain.spec.ts` runs both a command decision and an evolve table through `@sekiban/dcb-domain/testing`; the package boundary rejects runtime imports from the kit. | `packages/dcb-domain/src/testing.ts`, `test/dcb-domain.spec.ts` |
| 12 | R33-3 #1/#2/#7/business-#10 closure gates preserve the two-clock separation. | The boundary forced-red probe catches clock reintroduction; retry tests catch per-attempt now recapture; branded decision-log types and absence of allocation identity catch SUID/clock coupling. | `.github/workflows/ci.yml`, `test/dcb-domain.spec.ts`, `packages/dcb-domain/src/types.ts` |
| 13 | G13–G27 regressions stay green and the new lanes are reachable; C/R evidence is non-self-referential. | CI runs pinned per-fixture diagnostics, three package-boundary probes, authoring/session/bridge/parse, and dedicated forced-red probes. `scripts/g20-candidate-check.mjs` validates G28 evidence digests and one exact retained-list append after C'. | `.github/workflows/ci.yml`, `scripts/dcb-domain-compile-fail-check.mjs`, `scripts/g20-candidate-check.mjs`, `docs/SDT-G28-deploy-evidence.json` |

## Guard-isolation matrix

Every mutation is recorded against the same sequence: baseline pass → upstream
guard observed passing → target branch/port reached → exact typed outcome or
finding → downstream call count zero. The package tests keep those observations
at the boundary (typecheck diagnostics, propagation spy, snapshot/commit spy,
and bridge registry), rather than treating a later state snapshot as proof of
which guard ran.

## Review closure matrix (PR #63 F1–F6)

| Finding | Closure evidence |
| --- | --- |
| F1 | `eventEligible(projector, cellTag, event)` is shared by eager and late paths and requires stored tag-id membership; the 2x2 fixture proves `order:a` cannot enter `order:b`. |
| F2 | `test:g28:boundary:source`, `:negative`, and `:package` are separate CI invocations with selected-gate completion attestation and individual forced-red probes; the aggregate checker also attests all three calls executed. |
| F3 | Exact canonical tag-value assertions cover staged/eligible/claim/sealed propagation, staged-tag v1→v2 authority, 2x2 late replay, read-only A + append B, cross-tag heads, whole-log seal, and 0/1/N discard. |
| F4 | `toRuntimeDomain()` maps authoring commands through `adaptRuntimeCommand`; the runtime port fixture proves barrier zero-write, second-attempt single allocation vector, canonical `OrderPlaced:2` + `g27`, and same-candidate unknown reconcile. |
| F5 | Five invalid inputs assert boundary-specific findings and zero downstream calls; WASM schema bypass, cross-boundary provenance, changing-clock retry, and runtime/compile DecisionLog identity negatives are included. |
| F6 | Six diagnostic fixtures are compiled without suppression by `scripts/dcb-domain-compile-fail-check.mjs`; each pins a TypeScript diagnostic code and message fragment, while the existing `@ts-expect-error` lane remains active. |

## Candidate protocol

Final candidate C' contains the review fixes, package, runtime bridge, CI, tests,
README, oracle map, PR body, and an evidence placeholder. The evidence records
the C' SHA and tree digests. Bookkeeping commit R' updates only
`docs/SDT-G28-deploy-evidence.json` and appends C' once to the retained-candidate
fetch list in `.github/workflows/ci.yml`; it does not change implementation or
the oracle map. No internal/test header forwarding or secret is included.

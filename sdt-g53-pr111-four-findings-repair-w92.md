# SDT-G53 PR #111 four-findings repair (W92)

## Scope and preflight

- PR: [#111](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/111)
- Starting head: `56acdd40510bcd9b1b9d45cf275db7d21117399d`
- Canonical preflight: `repair-required`, `actionable=true`, using ordinary blocker comment [5521088094](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/111#issuecomment-5521088094).
- Canonical PR claim was acquired before edits.

This repair is limited to the four deterministic request-update findings.  It does not deploy, invoke Wrangler, change configuration, alter commit/convergence/trace behavior, or rerun or stitch the W89/W90 deployed evidence.  Existing W89/W90 evidence and artifacts remain preserved.

## Repairs

1. `test/g45-head-facts.spec.ts` now parses fake namespace identifiers with the exported canonical `parseScopeName` grammar.  It selects a tag identity only for `tag` objects and retains the existing exact response bytes.
2. `test/journal.spec.ts` now includes the explicit `.test` service identity for diagnostic GET and POST requests.  The seeded Journal and `GET /state` therefore address the same scoped Durable Object; no retired route or scheduling behavior was restored.
3. `test/g24-hardening.spec.ts` now proves the authorized explicit `.test` identity reaches ordinary V1 validation, while a request with neither deployment nor test identity receives typed `503 scope.identity_missing`.  The CI-level G53 control-route and downstream old-name mutation runners execute after the G24 tests.
4. `samples/meeting-room/src/d1-mv.ts` imports service-identity helpers through `@sekiban/dcb-runtime/cloudflare`, the Cloudflare-safe public boundary, instead of the root package path that reaches the PostgreSQL provider graph.  The scope grammar remains solely in the shared runtime implementation.

## Validation

All commands passed locally from the repaired branch:

- `npm run test:g20` and `node scripts/g20-cloudflare-gate.mjs` (including import-graph and mutation proof)
- `npm run test:g45` (contract, focused test, and four production-mutant checks)
- `npm run test:g21 && npm run test:g22 && npm run test:g23 && npm run test:g24 && npm run test:g25 && npm run test:g54 && npm run test:g53`
- `npm run lint`
- `npm run typecheck`

The G53 run reported both `comparison-removed` and `identity-missing-pass-through` control-route mutants red, plus the downstream retired `service|tag` name mutant red.  CI is handed off on the pushed repair head; any current-head unrelated failure will be reported without a gate change.

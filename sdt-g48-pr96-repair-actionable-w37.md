# SDT-G48 PR #96 repair — W37

## Scope

Repair the durable AC9 blocker on PR #96 at reviewed head
`eb2cf1a2773ea6235658381b6c1beb524f00e4bc`: the G32 legacy-ingress audit's
expected fixture inventory still listed `test/commit.spec.ts` after SDT-G48
retired that file's direct Journal alarm/recovery fixture.

## Narrow fix

- Removed only `test/commit.spec.ts` from
  `expectedLegacyFixtureReferences` in `scripts/g32-legacy-ingress-audit.mjs`.
- Recorded why the historical test reference disappeared in
  `docs/SDT-G48-evidence.md`.
- Kept `LEGACY_INPUT`, recursive filesystem derivation, exact ordered set
  comparison, and the G32 audit's self-test/mutation behavior unchanged.

## Explicit non-scope

No `test/repair.spec.ts`, G41 fixture, or `CommitWorker` behavior changed.
`GET /state` remains retained and `GET /result` remains removed.

## Verification

- `node scripts/g32-legacy-ingress-audit.mjs --self-test` passed, including
  the `eventPayloadVersion` and `legacy-provenance` forced-red mutations.
- `npm run test:g32` passed package build and all 50 targeted Vitest tests,
  plus the G32 production, admission, tag-derivation, and forward-recorder
  mutation probes. Its later `test:store-contract` dependency could not reach
  the local Postgres service at `127.0.0.1:54329`; no test or gate was changed
  to bypass that sandbox infrastructure failure.
- `npm run test:g41` passed: the unchanged zero-JOURNAL fixture, the full G41
  checker/self-test, and the production mutation runner all passed, including
  both independent re-added-removed-route and removed-retained-route forced-red
  directions.
- `npm run lint` passed.

The final commit, exact pushed PR head, and CI status are reported through the
canonical worker/result-report workflow after push.

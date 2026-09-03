# SDT-G54 PR #108 known-divergence repair — W80

Issue: [#105](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/105)

PR: [#108](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/108)

Starting PR head: `94ca790161a4122ecaa012212804840b04c5acf7`
Authority: SDT-G54 packet amendment `16197d151`; design record
[Sekiban#1172 comment 5518115881](https://github.com/J-Tech-Japan/Sekiban/issues/1172#issuecomment-5518115881).

## Bounded repair

W79's fail-closed validation remains unchanged: a V1 envelope with an empty
`lastSortableUniqueId` is rejected before any Durable Object binding call with
HTTP 400 `invalid_sortable_unique_id`. No Worker/runtime source, frozen golden
source bytes, SHA pins, transport behavior, deployment configuration, or
deployment was changed.

`test/fixtures/g54-known-divergences.json` is the checked-in, explicit
temporary contract for the four positive shared witnesses with the C# empty-head
assertion semantics that SDT-G56 will implement:

| Input fixture | Expected V1 bytes | Current exact runtime result | Resolving unit |
| --- | --- | --- | --- |
| `interop_official_v1_populated.json` | Frozen source V1 bytes | HTTP 400 `invalid_sortable_unique_id`, pre-DO | SDT-G56 |
| `interop_r2_canonical_positive_v1.json` | Frozen source V1 bytes | HTTP 400 `invalid_sortable_unique_id`, pre-DO | SDT-G56 |
| `interop_ts_client_model.json` | Byte-identical `interop_official_v1_populated.json` adapter output | HTTP 400 `invalid_sortable_unique_id`, pre-DO | SDT-G56 |
| `interop_r2_canonical_positive.json` | Byte-identical `interop_r2_canonical_positive_v1.json` adapter output | HTTP 400 `invalid_sortable_unique_id`, pre-DO | SDT-G56 |

This is a **known divergence, not a passing reclassification**. The
expectations retain each fixture's manifest outcome and pin the empty-head
reason, exact HTTP status/code, rejected member, and `SDT-G56`. All remaining
fixtures retain their original manifest expectations.

## Enforcement and evidence

- `scripts/g54-interop-runner.mjs` verifies the copied source pins and all
  fifteen manifest outcomes, exact direct/adapter V1 bytes, candidate-part R1
  payload bytes, and emits four `known-divergence` records with
  `invalid_sortable_unique_id` and `SDT-G56`.
- `test/g54-known-divergence.spec.ts` invokes the actual commit Worker with
  fake namespaces. It verifies exact adapter bytes and candidate payload bytes,
  exact typed HTTP 400 rejection, and zero calls to every Durable Object
  namespace for each witness.
- `scripts/g54-known-divergence-mutation-runner.mjs` simulates unexpected
  acceptance. It is required to turn red and emitted
  `known-divergence-unexpected-acceptance-mutant-red`; SDT-G56 must deliberately
  change this expectation when it implements assert-empty.

## Local verification

- `npm run build:packages && npm exec -- vitest run --config vitest.config.ts --maxWorkers=1 test/commit.spec.ts test/g54-envelope-boundary.spec.ts test/g54-interop.spec.ts test/g54-known-divergence.spec.ts` — 27 passing tests.
- `node scripts/g54-interop-runner.mjs` — 17 pinned source files, 15 manifest
  fixtures, and four explicit known divergences verified.
- `node scripts/g54-known-divergence-mutation-runner.mjs` — forced-red
  unexpected-acceptance proof passed.
- `npm run test:g54` — passed, including the existing required-field omission
  mutant and the new unexpected-acceptance mutant.
- `npm run typecheck --silent` — passed.

No deployment was performed.

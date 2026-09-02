# SDT-G54 PR #108 repair — W79

Task: `SDT-G54-PR108-REPAIR-W79`
PR: [#108](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/108)
Reviewed starting head: `be3434ecb8b93a4c7ade6c762f8f81311c781e88`
Packet authority: `907bcee02`
Deployment: not performed (forbidden)

## Repair scope

The canonical GitHub-only PR claim was applied before editing. This repair
addresses only review `5096020232` and blocker comment `5517581656`.

1. The stale live-Worker `test/commit.spec.ts` bare-envelope assertion now
   requires HTTP 400 `malformed_commit_envelope`, and asserts that the typed
   reason names `eventCandidates` and `consistencyTags`. A separate assertion
   keeps explicit `eventCandidates: []` plus `consistencyTags: []` at HTTP 200
   with the empty commit response.
2. `validateCommitEnvelope` once again validates every supplied
   `lastSortableUniqueId` before tag membership/admission or a Durable Object
   operation. An empty string now returns HTTP 400
   `invalid_sortable_unique_id`. The focused fake-namespace fixture proves
   zero `idFromName`, `get`, and `fetch` calls for `ALLOCATOR`, `BOOTSTRAP`,
   `TAG`, and the carried `TAG_STATE` namespace.

The existing G32 fixture normalization omits an unobserved consistency entry
instead of sending an invalid empty head. Copied interop source files and the
unchanged client transport remain byte-identical; their empty-head witness is
now explicitly recorded as the same ordered typed runtime rejection.

## Local validation

- `npm run build:packages && npm exec -- vitest run --config vitest.config.ts --maxWorkers=1 test/commit.spec.ts test/g54-envelope-boundary.spec.ts test/g54-interop.spec.ts` — passed, 22 tests.
- `npm run test:g54` — passed: SHA-pinned dependency-free interop runner, 13
  focused tests, and `production-omission-mutant-red`.
- `npm run typecheck --silent` — passed.

The prior exact-head CI failure was limited to `ci-foundation` and aggregate
`verify`; the dedicated G54 lane and `ci-g43` were already green. A new push
is required for CI to evaluate this repair head.

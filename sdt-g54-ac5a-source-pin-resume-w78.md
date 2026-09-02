# SDT-G54 AC5a source-pin resume — W78

Task: `SDT-G54-AC5A-SOURCE-PIN-RESUME-W78`
Issue: [#105](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/105)
Status: completed pending PR creation

## Amendment consumed

W77 stopped without implementation because the stale source pin `f53ffdc…`
contained only the old three-fixture set and provenance. W78 authorizes
`J-Tech-Japan/Sekiban@23589cf2b0616dad8532a9119e6f18d207c3be63`, which was
read directly and contains the required fifteen `interop_*.json` fixtures,
`interop_manifest.json`, and `PROVENANCE.md`. The source was copied
byte-for-byte under `test/fixtures/g54-sekiban-interop/`; its seventeen source
files are SHA-256 pinned in `SHA256SUMS` and verified by the Node runner.

The embedded upstream `f53ffdc…` provenance remains frozen source content; it
was not edited to conceal the amended retrieval commit. See
`docs/SDT-G54-evidence.md` for the complete source and outcome evidence.

## Delivered contract

- `validateCommitEnvelope` now rejects absent/non-array `eventCandidates` or
  `consistencyTags`, and detects `candidates` / `consistency` client aliases
  with a named `malformed_commit_envelope` reason before any Durable Object.
  The source client fixture without `version` receives the same named
  mis-dialect response.
- Explicit empty V1 arrays retain the existing 200 empty-commit response.
  The copied official V1 fixture is accepted, including its explicit empty
  consistency head.
- The client public `projectorVersion` is a string; type-level and runtime
  vocabulary proofs cover it without changing the meeting-room adapter.
- The dependency-free Node runner pins and classifies the full upstream
  catalogue. Actual runtime/client tests exercise R1, R2 adapter bytes, R3
  payload typed errors, and existing empty-tag/duplicate-consistency typed
  runtime errors.
- The C-12 production omission mutant is red, and the complete G54 lane plus
  forced-red reachability is wired into `ci-g21-g25`.

No client wire translation was added to the runtime. No raw-JSON duplicate
scanner was added to the runtime; duplicate raw members remain a client-side
frozen-runner input limitation as required. No deployment, Wrangler use, or
configuration change occurred.

## Validation

- Pre-fix current-main focused guard: red (`expected 400, received 200` for
  both aliases and bare V1); recorded in the evidence document.
- `npm run test:g54`: passed — package build, 17-file SHA pin runner, 12
  focused tests, and production omission mutant red.
- `npm run lint`: passed.
- `npm run typecheck --silent`: passed.
- `npm run test:g49`: passed including binding/migration mutants.
- Focused G41 journal tests and static self-test passed. Focused G51 trace and
  regression/bisect checks passed; their unchanged historic mutation helper
  cannot resolve the absent worktree-local `node_modules/vitest/vitest.mjs`
  path, while CI supplies it with `npm ci`.

## PR handoff

The commit SHA, PR URL, canonical worker completion outcome, and push result
are appended after the branch is pushed and the non-draft PR is created.

# SDT-G56 local AC1–AC5 checkpoint — W133

Task: `SDT-G56-LOCAL-AC1-AC5-W133`
Issue: [J-Tech-Japan/sekiban-dcb-ts#109](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/109)
Branch: `claude/sdt-g56-local-ac1-ac5-w133`
Base: `origin/main` = `a41839ff8ba117244d55ffcf2ecffd4d3b8df051`
Implementation checkpoint commit: `a793a74cc639686c668fd6fef901b0774010d07e` (`feat(g56): accept explicit empty tag heads`)

The local half is complete for AC1–AC5 and the checkpoint is pushed. No
Wrangler, Cloudflare read/write, deployment script, remote resource, PR, or
worker-complete transition was used. The preserved G60/G62 worktrees and
evidence were not touched.

## AC1–AC4 behavior

- `validateCommitEnvelope` now treats only V1 `lastSortableUniqueId: ""` as
  the explicit assert-empty sentinel. `null`, non-string values, and malformed
  non-empty values retain their typed `malformed_commit_envelope` or
  `invalid_sortable_unique_id` responses. The direct malformed-request oracle
  observed zero Durable Object calls.
- Both SQL-backed and fallback Tag Durable Object acquire paths validate an
  assert-empty request against an empty committed event set/head and reject a
  conflicting active reservation with the exact reason
  `consistency_head_mismatch_assert_empty`. An asserted-empty reservation does
  not manufacture a version or event; its first append remains version 1.
- The focused runtime test proves the first empty reservation has zero events,
  the append leaves one event at version 1, a repeated empty assertion is a
  typed `consistency_conflict`, and concurrent serialized commits have exactly
  one `200` winner and one `400` typed conflict.
- Session reads retain empty only after a `PortableSnapshot`/`exists=false`
  observation; never-read tags remain absent. The dcb-client and meeting-room
  V1 adapters preserve the empty string byte-for-byte and omit unknown/null
  claims.

## Durable red/green/race evidence

- Pre-change red receipt: [.artifacts/g56-red-before-green-w133.txt](.artifacts/g56-red-before-green-w133.txt).
  On the base path, the focused oracle recorded three failures: empty V1
  validation, Tag acquire HTTP 400 instead of 201, and Session head `null`
  instead of `""`.
- Green and mutation receipt: [.artifacts/g56-omission-mutant-red-w133.txt](.artifacts/g56-omission-mutant-red-w133.txt).
  The accepted implementation passed; mutating the validator branch to
  unconditional SUID validation made the focused oracle exit 1, and the
  source was restored in `finally`.
- Race/first-write receipt: [.artifacts/g56-race-winner-green-w133.txt](.artifacts/g56-race-winner-green-w133.txt).
  It records `[201,409]` for direct acquire, `[200,400]` for two concurrent
  serialized commits, loser code `consistency_conflict`, and the committed
  empty-assert path's `events=1`, `version=1` result.
- The new guard is wired into the existing CI conformance job in
  `.github/workflows/ci.yml` as `npm run test:g56`, with a forced-red
  reachability step. `SDT_G56_FORCE_FAILURE=1 npm run test:g56:forced-red`
  exited 1 as designed.

## AC5 G54 acceptance catalogue

The four former empty-head divergence fixtures are now explicit
`accepted-positive` entries resolving to SDT-G56:

1. `interop_official_v1_populated.json` → itself (official V1/R1).
2. `interop_r2_canonical_positive_v1.json` → itself.
3. `interop_ts_client_model.json` → `interop_official_v1_populated.json`.
4. `interop_r2_canonical_positive.json` → `interop_r2_canonical_positive_v1.json`.

The copied fixture bytes and `SHA256SUMS` were not edited. The exact check
`sha256sum -c test/fixtures/g54-sekiban-interop/SHA256SUMS` reported all 17
files `OK`. The G54 acceptance runner reported
`acceptedPositiveCount: 4`; its required-envelope omission mutant and the
new accepted-positive mutant both went red.

## Local gate record

| Gate | Result |
| --- | --- |
| `npm run test:g56` | PASS; 3 focused tests, green guard, omission mutant red |
| `npm run test:g54` | PASS; 18 tests, four accepted positives, both mutation checks red |
| `npm run test:g44` | PASS; 8 tests and all four production mutants red |
| `npm run test:g41` | PASS; 8 tests and production mutants red; the runner emitted existing teardown diagnostics but exited 0 |
| `npm run test:g49` | PASS; binding/migration/lineage mutants red |
| G51 non-deploy subset | PASS; 4 selected tests, regression self-test/reference/bisect, and native-span mutant red |
| G53 non-deploy subset | PASS; 10 tests and scope/mutation checks red; deployment self-test intentionally omitted |
| `npm run test:g55` | PASS; 12 tests and read-visibility guard |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |
| focused `commit.spec.ts` | PASS; 9 tests |
| focused `dcb-domain.spec.ts` | PASS; 20 tests |
| focused `tag.spec.ts` | PASS; 10 tests |

`npm run test:g52` was run and remains red in the repository's file-wide
execution: 1 of 18 tests fails with `paced state has no valid persisted cohort
window` in the Worker-only snapshot-root case. Running that case alone passes.
The full Vitest suite likewise remains red under its existing concurrent
execution (the same G52 case plus timeouts in unrelated `commit.spec.ts` AC7
and `tag.spec.ts` G5); each affected focused file passes. No unrelated G52,
test timeout, or generated-receipt change was made. Build `dist` output is
ignored and produced only by the local gates.

## Scope boundary and remaining work

AC1–AC5 are local only. AC6–AC8 remain unfinished: deployed verification,
deployed/e2e evidence and final consolidated evidence/PR completion remain for
the later continuation. No Cloudflare write path was attempted during this
checkpoint. The 5,000 ms unsafe contract, omitted-entry meaning, V2/wire
members, ordering, fences, traces, timeouts, outbox/Queue/global admission,
projector advancement, and unrelated code remain unchanged. G60 remains the
next unit once writes return; G61 remains after G62. This checkpoint does not
initiate any later deployed G56 obligations.

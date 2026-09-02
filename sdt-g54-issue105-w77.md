# SDT-G54 Issue #105 — W77 source-contract stop

Task: `SDT-G54-ISSUE105-W77`

## Completed safe setup

- Read the standalone GitHub issue contract and ran the canonical GitHub-only
  worker claim for issue #105. The claim applied `intent-issue-in-progress`.
- Created the dedicated branch `claude/sdt-g54-envelope-interop-w77` from
  `origin/main` at `44bbe60a3df507dbb383ecb28d9f4d17bfc587c3`.
- No runtime, client, transport, fixture, CI, or deployment file was changed.
  No deployment, app request, PR, or alternate-source copy was made.

## Blocking source contradiction

AC5a requires exactly fifteen Sekiban interop JSON goldens, an
`interop_manifest.json`, and `PROVENANCE.md`, copied from
`J-Tech-Japan/Sekiban@f53ffdc69e225433b266cc1f92875d6b2b11aa93` with SHA-256
pins. Direct GitHub contents and recursive-tree reads at that exact commit show
the specified `SerializedCommitWire/goldens/` directory contains only four
files:

1. `PROVENANCE.md`
2. `legacy_1017_empty.json`
3. `legacy_1017_unversioned.json`
4. `ts_client_aliased_unversioned.json`

It has no `interop_manifest.json` and none of the fifteen required
`interop_*.json` artifacts. Therefore no SHA-256 pin set or dependency-free
AC5a runner can honestly be implemented from the mandated source revision.

Read-only discovery found that the expected interop artifacts first appear in
Sekiban commit `23589cf2b0616dad8532a9119e6f18d207c3be63`
(`test(dcb): add serialized commit interop evidence (#1179)`), but this task
authorizes only `f53ffdc69e225433b266cc1f92875d6b2b11aa93`. I did not silently
substitute that later revision.

## Required clarification

Design/orchestration must amend the GitHub issue and task input to authorize
the correct immutable source commit (or otherwise publish the required fifteen
files and manifest at the currently pinned commit). After that amendment, this
same G54 branch can implement AC1–AC6 without translating the client dialect,
changing valid-envelope transport semantics, or deploying.

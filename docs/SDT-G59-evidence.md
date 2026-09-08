# SDT-G59 release-prep evidence

Date: 2026-09-08 (America/Los_Angeles)

This checkpoint prepares `@sekiban/dcb-domain` `0.1.0` for an operator-owned
release. It does not publish to npm and does not handle or create npm
credentials. The implementation branch is
`claude/sdt-g59-npm-010-release-prep-w172`, based on `origin/main` at
`5b643ef`. The implementation source commit is
`5294f6666accfc0ba26e81e17562ba1c37f0bf4f`.

## Manifest and package boundary

The package is public (`private: false`), version `0.1.0`, licensed
`Elastic-2.0`, and declares the repository directory
`packages/dcb-domain`. It has Node `>=20`, `sideEffects: false`, the public
`zod` `4.4.3` dependency only, and `publishConfig.access=public` with
`publishConfig.provenance=true`. Its publish allowlist is exactly:

```text
dist/
README.md
LICENSE
package.json
```

The package `prepack` hook prepares a copy of the repository Elastic License
and makes declaration specifiers Node16-compatible after declaration emit. This
keeps the pre-existing workspace `build` command unchanged for the G40 CI
inventory while ensuring every pack/publish tarball has the release files.

## Release-prep receipts

The following commands were run from the child worktree with the committed
lockfile. `NPM_CONFIG_CACHE=/tmp/sdt-g59-npm-cache` was used locally because
the managed environment denied writes to the default npm log directory; it
does not contain credentials.

```text
npm ci --ignore-scripts                             PASS (199 packages; no lockfile diff)
npm run lint                                        PASS
npm run typecheck                                   PASS
npm run typecheck --workspace @sekiban/dcb-domain  PASS
npm run test:g28:compile-fail                       PASS (6 pinned fixtures)
npm run test:g28:boundaries                         PASS (source, negatives, package manifest)
npm run test:g59                                    PASS
```

The release-specific `test:g59` gate performs all of the following:

```text
build @sekiban/dcb-domain                          PASS
dcb-domain-pack-check                               PASS
  files: 23; unpacked size: 699358 bytes; ceiling: 1000000 bytes
  required: package.json, README.md, LICENSE, dist/index.js/.d.ts,
            dist/testing.js/.d.ts
  source/fixtures/maps absent from tarball; no unexpected entries
dcb-domain-consumer-check                           PASS
  external temporary project, Node16 module resolution: compile/runtime PASS
  external temporary project, bundler resolution: compile PASS
  public imports: domain, command, read, readExists, done, none, reject,
                  Session, PortableSnapshot, and ./testing helpers
  deep import outside . and ./testing: rejected by the package boundary
dcb-domain-release-check dcb-domain-v0.1.0          PASS (tag/version match)
dcb-domain-release-notes dcb-domain-v0.1.0          PASS (CHANGELOG section extracted)
```

The package README documents install, the frozen `0.1.x` surface, semver
policy, the older `@sekiban/core` line distinction, and the tag workflow.
`docs/release-process.md` documents trusted publishing and the `NPM_TOKEN`
fallback without embedding credentials.

## Workflows and operator action

`.github/workflows/dcb-domain-release-preflight.yml` runs the package build,
typecheck, pack guard, clean consumer, tag/version check, and changelog check
on the relevant pull-request paths and by manual dispatch.

`.github/workflows/release-dcb-domain.yml` is tag-driven on
`dcb-domain-v*`, grants `id-token: write`, repeats the gates, creates/updates
release notes, and reaches the publish step only when the operator has
configured trusted publishing or `NPM_TOKEN`. With neither configured it runs
the explicit no-publish dry-run path and exits green with a notice.

The exact final operator publish command, from `packages/dcb-domain`, is:

```sh
npm publish --provenance --access public
```

The tag workflow now runs `npm run test:g59` before its pack/consumer checks
and before either publish branch. It also runs the credential-free exact
release-path proof `npm publish --dry-run --provenance --access public` on
every tag run, logging `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW`, the
exact command and npm's output before the conditional real publish step. The
preflight workflow runs the same no-credential proof on pull requests.

The clean-consumer guard now has both emitted consumers: Node16 and Bundler
TypeScript output are executed, and an esbuild bundle is executed as well. It
tests the shipped `dist/index.js` path (which exists in the tarball) under both
Node16 and Bundler package resolution and requires the package exports map to
reject it. C-12 red receipts run before the green receipt: a temporary stray
package entry is rejected by the pack guard, and a temporary pre-change
`private: true` manifest is rejected with `package must be public`; both files
are restored before the positive pack/consumer proof.

The operator sequence is to verify the ready PR, configure the trusted
publisher plus `NPM_TRUSTED_PUBLISHING=true`, or configure `NPM_TOKEN`, create
and push `dcb-domain-v0.1.0`, then verify the public npm version and provenance
badge. The npm trusted-publisher workflow value is the filename
`release-dcb-domain.yml`. No real publish or tag push was performed by this
implementation checkpoint; only credential-free dry-runs were executed.

## W172 review-repair receipts

The scoped review repair source is `8c3341187dff2fc48cb9eb830f33d9af34bd9389`.
The focused consumer command produced this green/red receipt on that exact
source:

```text
NPM_CONFIG_CACHE=/tmp/sdt-g59-npm-cache node scripts/dcb-domain-consumer-check.mjs
PASS
green: Node16 emitted consumer compile/runtime; Bundler emitted consumer
       compile/runtime; esbuild bundle runtime; Node16 and Bundler shipped
       dist deep-import rejection
red:   stray-file -> SDT-G59 pack guard: unexpected package entries:
       .g59-stray-file-probe
       pre-change-private-manifest -> SDT-G59 pack guard: package must be public
       shipped-dist-deep-import-node16-and-bundler -> package exports rejected
       @sekiban/dcb-domain/dist/index.js in both resolutions
```

The credential-free release-path proof was run without credentials and without
publishing:

```text
head=8c3341187dff2fc48cb9eb830f33d9af34bd9389
run_id=local-2026-09-08
workflow=local-release-path-proof
command=npm publish --dry-run --provenance --access public
name: @sekiban/dcb-domain@0.1.0
tarball: 23 files; package size 110.6 kB; unpacked size 699.4 kB
shasum: 04fb7cfdc2d3d6682d0ed42162dc2366378f8cee
publishing: https://registry.npmjs.org/ latest/public (dry-run)
result: + @sekiban/dcb-domain@0.1.0
```

The workflows emit the same `head`, `run_id`, workflow name, exact command and
full npm output into the hosted log before the conditional real publish step.
No npm credential was created or used, and no tag or real publish was run.

## Existing aggregate-lane exceptions

The first repository-wide attempt inherited the parent worktree's stale
`node_modules` symlinks and failed during unrelated package type resolution
(`SnapshotReader.head`, G60/G65/G67 exports). This was classified as a local
worktree setup issue and corrected by `npm ci` in the child; the lockfile was
unchanged.

With isolated dependencies, `npm run check` passed lint, root typecheck/build,
G28 compile-fail and boundary gates, then the unchanged aggregate `npm test`
reported 6 failed files / 7 failed tests / 88 passed / 1 skipped:

```text
test/commit.spec.ts           AC7 timeout at 5000ms
test/g43-measurement.spec.ts  bounded-spread assertion: 24 > 2
test/g43-tag-sql.spec.ts      AC6 waitForConfiguredAlarm returned null
test/g67-safe-lane.spec.ts    AC3 timeout at 5000ms
test/repair.spec.ts           two existing tests timed out (15000ms and 5000ms)
test/tag.spec.ts              G5 timeout at 5000ms
```

These tests and their assertions were not changed by G59. The local runtime is
Node `23.10.0` while the repository workflows use Node 24, and the output
included existing Vitest/Workers teardown and alarm-race diagnostics. The
aggregate result is therefore not claimed green; hosted CI is the authoritative
release gate and must be green before release publication. No G59-specific
release gate depends on these failures.

## Hosted exact-head repair checkpoint

The first hosted PR run was `34232255964` at the pre-repair evidence head. Its
release-specific preflight passed:

```text
dcb-domain-release-preflight
https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34232256007/job/102081058554
PASS
```

The repository-wide coverage lane initially failed because the G59 package
`build` script had changed the existing command inventory. The exact failure
was `ci-coverage`, job
`https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34232255964/job/102081059970`:
G40 reported the pre-existing build command as missing. The repair restores
that command byte-for-byte and moves release-only preparation to `prepack`;
the local G40 guard now reports `missing: []`.

The same pre-repair run also exposed unrelated inherited failures outside the
G59 range: `ci-g21-g25`, job
`https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34232255964/job/102081060302`,
failed unchanged `test/g22-bootstrap-d1.spec.ts` canonical-key divergence
(expected zero mutation, received one), and `ci-g46`, job
`https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34232255964/job/102081060399`,
failed unchanged `test/read.spec.ts` high-lag fail-closed behavior (expected
HTTP 500, received 200). `git diff origin/main...HEAD` contains neither
`test/read.spec.ts` nor the runtime/G22 implementation paths, so these are
recorded as inherited lane exceptions rather than G59 findings. The repaired
head must still be evaluated by exact-head hosted CI; no gate is skipped or
called green based on this classification.

No Cloudflare, deployment, resource, or npm registry mutation occurred.

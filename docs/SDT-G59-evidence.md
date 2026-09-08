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

The package build prepares a copy of the repository Elastic License into the
package before compiling. Declaration specifiers are made Node16-compatible
after declaration emit; this keeps the source authoring imports unchanged and
lets an installed package resolve its `dist/*.d.ts` graph under Node16.

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
  files: 23; unpacked size: 699343 bytes; ceiling: 1000000 bytes
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

The operator sequence is to verify the ready PR, configure the trusted
publisher or `NPM_TOKEN`, create and push `dcb-domain-v0.1.0`, then verify the
public npm version and provenance badge. No `npm publish` command was invoked
by this implementation checkpoint; only `npm pack --dry-run` was executed.

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

No Cloudflare, deployment, resource, or npm registry mutation occurred.

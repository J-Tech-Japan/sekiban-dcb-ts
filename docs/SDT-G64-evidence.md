# SDT-G64 matched package-set evidence

This document records the release-preparation proof for issue #120. It does
not publish packages, create credentials, create a tag, or change runtime API
behavior. The matched release set is `@sekiban/dcb-core`,
`@sekiban/dcb-domain`, and `@sekiban/dcb-client`, all at `0.1.0`.

## Acceptance map

| Acceptance | Local proof in this checkpoint |
| --- | --- |
| AC1 package metadata and matched dependencies | `scripts/dcb-matched-set-pack-check.mjs` checks public metadata, exact versions, `@sekiban/dcb-client` runtime dependencies, exports, license and package allowlists. |
| AC2 tarball contents | The pack guard runs `npm pack --dry-run --json` for all three packages and rejects source/config/map leakage. |
| AC3 consumer compatibility | The consumer guard installs the three tarballs outside the workspace, compiles/runs a real `createSekibanExecutor` V1 command under Node16 and Bundler resolution, runs an esbuild bundle, and compares the raw UTF-8 V1 commit body bytes. |
| AC4 negative boundaries | Red probes reject a stray package file, a private pre-change manifest, and `@sekiban/dcb-domain/dist/index.js` under Node16 and Bundler package exports. |
| AC5 release workflow | `.github/workflows/release-dcb-matched-set.yml` verifies the tag, runs the domain suite and matched-set gates before any publish step, then runs `scripts/dcb-matched-set-publish-dry-run.mjs` in core → domain → client order for a credential-free provenance dry-run. |
| AC6 dependency order | The workflow publishes core, domain, then client, with the release guard requiring `dcb-v0.1.0`. |
| AC7 provenance activation | The workflow supports npm trusted publishing with `NPM_TRUSTED_PUBLISHING=true` and `id-token: write`, or the operator-supplied `NPM_TOKEN` fallback. |
| AC8 operator handoff | Exact later tag and publish commands are recorded below; this checkpoint does not execute them. |

## Downstream consumer installation

The SekibanWasmRuntime consumer installs the matched public set at one exact
version. The dependency order is core first, domain second, and client third;
the client manifest carries both exact runtime dependencies. A consumer then
imports `createSekibanExecutor` from `@sekiban/dcb-client` and domain authoring
helpers from `@sekiban/dcb-domain`, never a `dist/**` deep path. The clean
consumer guard below compiles and runs that executor against a fake HTTP
transport and checks the serialized V1 envelope bytes.

## Local receipts

The implementation checkpoint is `e0ffe8c` on branch
`claude/sdt-g64-npm-matched-set-claim-recovery-w174`; the evidence-only
follow-up that pins this receipt is the final head of this PR. The focused
receipts were run with `NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache`
because the host npm cache is root-owned; this changes only the local cache
location and is not a release credential or a test wrapper.

```text
NPM_CONFIG_CACHE=... npm run test:g64                         PASS
  build: core/domain/client; pack: all 3 exact allowlists and <=1 MB;
  consumer: Node16 + Bundler + esbuild V1 compile/runtime and raw-byte PASS;
  release guard: dcb-v0.1.0 order core -> domain -> client PASS;
  publish dry-run: all 3 npm publish --dry-run commands status 0
  expected red probes: stray core/client, private pre-change manifest,
    and six shipped dist deep-import Node16/Bundler probes all detected
NPM_CONFIG_CACHE=... SDT_G64_FORCE_FAILURE=1 npm run test:g64:forced-red
  inner command exited 1 at the intentional forced failure; wrapper classified
  the failure as expected (the guard did not escape)
NPM_CONFIG_CACHE=... npm run lint                         PASS
NPM_CONFIG_CACHE=... npm run typecheck                    PASS
NPM_CONFIG_CACHE=... npm run test:g28                     PASS (20/20)
NPM_CONFIG_CACHE=... npm run test:g59                     PASS
node scripts/g40-ci-coverage-check.mjs                   PASS
git diff --cached --check                                 PASS
```

The packaged facade emitted the same raw V1 request in Node16, Bundler, and
esbuild consumers:

```text
{"version":1,"eventCandidates":[{"payload":"eyJyb29tSWQiOiJyb29tLTEifQ==","eventPayloadName":"RoomOpened","tags":["room:room-1"]}],"consistencyTags":[{"tag":"room:room-1","lastSortableUniqueId":""}]}
```

The assertion compares UTF-8 bytes, not a decoded object: byte length `199`,
SHA-256 `5c46a252c8d4136de1c0d842ba39732cbb58983957488053431639ebfa2c2695`.
The raw dry-run script records each command's stdout/stderr and status. The
fresh receipt had status `0` for all three packages, in order:

```text
@sekiban/dcb-core  sekiban-dcb-core-0.1.0.tgz  package 11.1 kB  unpacked 51.6 kB  shasum 229ec62ef961eaa269d2cff226312ebe83c17309
@sekiban/dcb-domain sekiban-dcb-domain-0.1.0.tgz package 110.6 kB unpacked 699.4 kB shasum 04fb7cfdc2d3d6682d0ed42162dc2366378f8cee
@sekiban/dcb-client sekiban-dcb-client-0.1.0.tgz package 99.7 kB  unpacked 638.4 kB shasum e63e66604feee26725a4d8d452a9ab3152e2dc50
each: npm publish --dry-run --provenance --access public
each: npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)
```

The npm dry-run emitted only package metadata normalization warnings for the
repository URL; it did not publish a package. The real tag/publish path remains
operator-only.

The repository-wide `npm test` was also run without changing its assertions,
timeouts, or retry behavior. It returned `6 failed, 88 passed, 1 skipped`
files and `7 failed, 789 passed, 1 skipped` tests. The failures were the
pre-existing/local timing and runner signatures in `test/commit.spec.ts`
(allocation/cancellation timeout), `test/g43-measurement.spec.ts` (row-read
spread), `test/g43-tag-sql.spec.ts` (AC6 alarm re-arm),
`test/g67-safe-lane.spec.ts` (unchanged 5,000 ms guard), `test/repair.spec.ts`
(re-query and scan timeouts), and `test/tag.spec.ts` (G5 timeout), alongside
the known teardown/Hyperdrive local-environment messages. No G64 test failed;
these exceptions are not called green and no gate was weakened.

The local CI-equivalent coverage inventory includes the new `ci-g64` command
and its forced-red probe in `verify.needs`; `node scripts/g40-ci-coverage-check.mjs`
passed against the resulting workflow. Hosted exact-head CI is the required
post-push check and is recorded in the handoff artifact/PR once available.

The first hosted run exposed a real compatibility gap in the pre-existing
G13 boundary fixture: `npm run test:boundaries` still asserted that the client
could depend only on core, while AC2 requires the exact matched core/domain
runtime pair. The store/D1 portions of `ci-local-e2e` passed. Commit `9da054d`
updates that guard to require exactly `@sekiban/dcb-core` and
`@sekiban/dcb-domain`; it does not permit arbitrary dependencies. The focused
boundary command, matched-set suite, lint, and diff check pass after that
repair. The hosted run that exposed this was `34253795826`, job
`102154365473`, `ci-local-e2e`; its terminal replacement run is the exact-head
CI check for the pushed repair.

The next exact-head consumer fixture review found the analogous stale G13
assumption that `@sekiban/dcb-core` must remain private. The matched release
contract makes core and client publishable while runtime remains private.
Commit `d5bbd5e` makes the fixture assert that exact split and leaves its
entrypoint, deep-import, tree-shaking, sample-source, and explicit runtime
subpath protections unchanged.

No `npm publish`, tag push, credential creation, deployment, or runtime API
operation was performed. The workflow's publish branches are operator-only;
the unauthenticated branch is the credential-free `npm publish --dry-run
--provenance --access public` proof.

The red probes are expected to fail in the mutated pre-change fixture and are
green only when the guard detects that failure. The clean receipts must show
the corresponding green package/consumer proof; a red probe is not counted as
a package-set failure.

## Operator-only activation

After review and merge, an operator performs the release from the approved
head, not from this child checkpoint:

```sh
git tag dcb-v0.1.0
git push origin dcb-v0.1.0
```

The tag workflow then verifies the release in dependency order and, only when
one of the two approved authentication paths is configured, runs:

```sh
(cd packages/dcb-core && npm publish --provenance --access public)
(cd packages/dcb-domain && npm publish --provenance --access public)
(cd packages/dcb-client && npm publish --provenance --access public)
```

The trusted-publisher path registers the exact workflow filename
`release-dcb-matched-set.yml`, sets the repository variable
`NPM_TRUSTED_PUBLISHING=true`, and relies on GitHub OIDC. The alternative is
an operator-managed `NPM_TOKEN` repository secret. If neither is present, the
workflow runs `npm publish --dry-run --provenance --access public` for each
package and exits without publishing.

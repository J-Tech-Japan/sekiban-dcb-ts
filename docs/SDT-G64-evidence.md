# SDT-G64 matched package-set evidence

This document records the release-preparation proof for issue #120. The original
W174/W176 source checkpoints did not publish packages, create credentials, or
create a tag. W177 repairs the tag workflow so an operator can publish the
matched set safely from this private repository; the workflow still changes no
runtime API behavior. For a private repository, the workflow omits the explicit
`--provenance` flag, sets `NPM_CONFIG_PROVENANCE=false`, and removes the
manifest-level `publishConfig.provenance` field from the isolated checkout
before authenticated publication. npm otherwise retains that static setting
even when the command-line flag is omitted. The matched release set is
`@sekiban/dcb-core`,
`@sekiban/dcb-domain`, and `@sekiban/dcb-client`, all at `0.1.0`.

## Acceptance map

| Acceptance | Local proof in this checkpoint |
| --- | --- |
| AC1 publishable manifests | `scripts/dcb-matched-set-pack-check.mjs` checks the public metadata, exports, license, README/allowlist, and publish shape for core, domain, and client. |
| AC2 dependency correctness | The pack guard checks that client runtime dependencies are exactly `@sekiban/dcb-core` and `@sekiban/dcb-domain` at the matched version, and that no workspace/file/link specifier leaks into the release set. |
| AC3 tarball guards | The pack guard runs `npm pack --dry-run --json` for all three packages, enforces the exact `dist/**`, README.md, LICENSE, and package.json allowlist and size bound, and detects stray-file mutations. |
| AC4 clean-consumer proof | The consumer guard installs the three tarballs outside the workspace, compiles/runs a real `createSekibanExecutor` V1 command under Node16 and Bundler resolution, runs an esbuild bundle, compares raw UTF-8 V1 commit bytes, and rejects undeclared deep imports. |
| AC5 release workflow | `.github/workflows/release-dcb-matched-set.yml` verifies the tag, detects repository visibility at runtime, runs the relevant domain/matched-set gates before any publish step, and uses a credential-free visibility-matched dry-run in core → domain → client order. Provenance is requested only for public repositories; private publishing also disables npm's implicit GitHub Actions provenance. |
| AC6 downstream-consumer documentation | `docs/release-process.md` and this evidence document explain the matched install/release procedure for the SekibanWasmRuntime consumer, including the exact package order and operator-only activation. |
| AC7 scope boundary | The sample, runtime API, `@sekiban/dcb-runtime`, and existing guards remain untouched. The source PR creates no credentials or deployment; the separately authorized operator release is recorded below. |
| AC8 lifecycle | The dedicated branch, non-draft PR, worker lifecycle receipts, exact-head CI, and evidence document are recorded; no lifecycle gate is weakened or timeout-inflated. |

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
  publish command-shape guard: public requires --provenance; private rejects it PASS
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
The consumer guard also runs a genuine negative mutation against the captured
fake-fetch body: it inserts one whitespace byte before `eventCandidates`,
proves `JSON.parse` still produces the same V1 object, and requires the raw
byte assertion to reject the mutation with `V1 raw-byte mismatch`. The
unmutated body then passes in each Node16, Bundler, and esbuild execution. This
is the red/green raw-wire proof requested by the review; it does not change
production transport serialization.
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

The W177 command-shape guard runs both policy branches. Its green receipt is:

```text
node scripts/dcb-matched-set-publish-dry-run.mjs --self-test       PASS
public:  npm publish --dry-run --provenance --access public
private: npm publish --dry-run --access public
private environment: NPM_CONFIG_PROVENANCE=false
private manifest preparation: npm pkg delete publishConfig.provenance
private provenance mutation: rejected (private publish must omit provenance)
```

The private branch retains `--access public`; it omits the unsupported
provenance flag, explicitly sets `NPM_CONFIG_PROVENANCE=false`, and runs
`npm pkg delete publishConfig.provenance` for core, domain, and client in the
isolated checkout immediately before publication. The workflow verifies that
the field is absent before continuing. The public branch retains both public
access and provenance. The self-test covers both command branches, the public
provenance red mutation, and the workflow's private metadata cleanup.
The workflow obtains `.private` from the live GitHub repository API before the
matched-set gates and exports the result as `REPO_IS_PRIVATE`; it fails closed
on any response other than the literal `true` or `false`. The publish step
uses the same branch, so the dry-run and authenticated/trusted-publisher paths
cannot silently disagree.

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

The W174/W176 source checkpoints performed no `npm publish`, tag push,
credential creation, deployment, or runtime API operation. The W177 hosted
attempt then supplied the concrete private-repository failure receipt needed
for this repair. Run `34279243680`, job
[`102241580965`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34279243680/job/102241580965),
reported `REPO_IS_PRIVATE=true` and reached the first authenticated core
publish with the old command `npm publish --provenance --access public`.
The raw npm receipt was:

```text
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=2762200566
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@sekiban%2fdcb-core - Error verifying sigstore provenance bundle: Unsupported GitHub Actions source repository visibility: "private". Only public source repositories are supported when publishing with provenance.
```

The job exited before domain/client publication; `npm view
@sekiban/dcb-core@0.1.0`, `@sekiban/dcb-domain@0.1.0`, and
`@sekiban/dcb-client@0.1.0` were all `E404` afterward, so no package was
published by that attempt. This is retained as a failed historical receipt,
not a passing release proof.

The first retry after the workflow repair proved that omitting the command-line
flag alone was insufficient for an actual GitHub Actions publish. The tag was
already on the merged W177 head, and run `34283301334`, job
[`102252928900`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34283301334/job/102252928900),
reported `REPO_IS_PRIVATE=true`; all pre-publish gates and the private dry-run
passed. The publish step printed the private command
`npm publish --access public`, but npm still emitted a provenance bundle and
the registry returned:

```text
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=2762463837
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@sekiban%2fdcb-core - Error verifying sigstore provenance bundle: Unsupported GitHub Actions source repository visibility: "private". Only public source repositories are supported when publishing with provenance.
```

The run exited before domain/client publication and no package was published.
The follow-up repair sets `NPM_CONFIG_PROVENANCE=false` only for the private
authenticated branch while keeping the public branch's explicit
`--provenance` behavior unchanged; the current repair additionally removes the
static manifest provenance setting before the private publish because the
second retry proved the environment override alone was insufficient.

The second retry after that environment-only repair was run `34284621489`, job
[`102257213293`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34284621489/job/102257213293).
It again resolved `REPO_IS_PRIVATE=true`; the command-shape, dry-run, build,
tarball, consumer, and domain gates passed, but the first authenticated core
publish still emitted a provenance bundle and failed with the same registry
response:

```text
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=2762575275
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@sekiban%2fdcb-core - Error verifying sigstore provenance bundle: Unsupported GitHub Actions source repository visibility: "private". Only public source repositories are supported when publishing with provenance.
```

No package was published by this run. The receipt is retained as the direct
evidence that static `publishConfig.provenance` must be removed in the private
isolated checkout; it is not a passing release proof.

The W176 G22 repair is explicitly a test-quality comparison normalization, not
an unchanged-test claim: `test/g22-bootstrap-d1.spec.ts` excludes only
driver-only timing metadata (`duration` and its sibling timing fields) from
the diagnostic `.all()` envelope comparison while retaining all semantic
fields and the zero-mutation canonical-key guard. The hosted finding was in
the `ci-g21-g25` lane, job `102174375025`, not `ci-local-e2e`; the failure was
the Miniflare `meta.duration` mismatch (`1` versus `0`). The repository audit
found no other same-shape semantic comparison requiring normalization.

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

The tag workflow detects the repository visibility before the publish step.
For a public repository it verifies the release in dependency order and, only
when one of the two approved authentication paths is configured, runs:

```sh
(cd packages/dcb-core && npm publish --provenance --access public)
(cd packages/dcb-domain && npm publish --provenance --access public)
(cd packages/dcb-client && npm publish --provenance --access public)
```

For this private repository the corresponding authenticated commands are the
same dependency order with provenance omitted. The tag workflow performs the
metadata deletion in its isolated checkout before these commands:

```sh
(cd packages/dcb-core && npm pkg delete publishConfig.provenance && NPM_CONFIG_PROVENANCE=false npm publish --access public)
(cd packages/dcb-domain && npm pkg delete publishConfig.provenance && NPM_CONFIG_PROVENANCE=false npm publish --access public)
(cd packages/dcb-client && npm pkg delete publishConfig.provenance && NPM_CONFIG_PROVENANCE=false npm publish --access public)
```

The trusted-publisher path registers the exact workflow filename
`release-dcb-matched-set.yml`, sets the repository variable
`NPM_TRUSTED_PUBLISHING=true`, and relies on GitHub OIDC. The alternative is
an operator-managed `NPM_TOKEN` repository secret. If neither is present, the
workflow runs the same visibility-matched credential-free dry-run for each
package and exits without publishing. On this private repository that
fallback is `npm publish --dry-run --access public`; the public-repository
fallback is `npm publish --dry-run --provenance --access public`.

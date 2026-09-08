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
| AC3 consumer compatibility | The consumer guard installs the three tarballs outside the workspace, compiles/runs a real `createSekibanExecutor` V1 command under Node16 and Bundler resolution, and runs an esbuild bundle. |
| AC4 negative boundaries | Red probes reject a stray package file, a private pre-change manifest, and `@sekiban/dcb-domain/dist/index.js` under Node16 and Bundler package exports. |
| AC5 release workflow | `.github/workflows/release-dcb-matched-set.yml` verifies the tag, runs the domain suite and matched-set gates before any publish step, then runs a credential-free provenance dry-run. |
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

The exact command/output receipts are filled after the checkpoint gates run:

```text
commit: pending
branch: claude/sdt-g64-npm-matched-set-claim-recovery-w174
commands: npm run test:g64; npm run lint; npm run typecheck; npm run test:g28; npm run test:g40:coverage
npm-publish: not run; workflow dry-run only
```

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

# npm release process

This repository releases `@sekiban/dcb-domain` from a version-matching tag.
The release workflow runs the package build, tarball allowlist guard, clean
consumer proof, typecheck and tests before it reaches the publish step.

## Operator setup

Use exactly one of these authentication paths in the `J-Tech-Japan/sekiban-dcb-ts`
repository; the implementation child does not create or handle either
credential:

1. Register the npm trusted publisher for repository
   `J-Tech-Japan/sekiban-dcb-ts` and the workflow filename
   `release-dcb-domain.yml` (npm asks for the filename, not the full
   `.github/workflows/` path). Set the repository variable
   `NPM_TRUSTED_PUBLISHING=true`. Trusted publishing uses GitHub Actions OIDC
   and the workflow's `id-token: write` permission.
2. As the fallback, add an `NPM_TOKEN` repository secret. Do not claim this
   path is configured until the operator has supplied the secret.

## Release steps

The operator verifies the dry-run PR and then runs:

```sh
git tag dcb-domain-v0.1.1
git push origin dcb-domain-v0.1.1
```

The tag workflow checks that the tag matches `packages/dcb-domain/package.json`,
creates the GitHub release notes from `CHANGELOG.md`, runs the existing
`@sekiban/dcb-domain` suite with `npm run test:g28`, runs the clean consumer
proof and `npm run test:g59` before any publish step, and publishes with:

```sh
npm publish --provenance --access public
```

If neither trusted publishing nor `NPM_TOKEN` is configured, the workflow
first runs the credential-free release-path proof
`npm publish --dry-run --provenance --access public` and records the GitHub
head, run id and command in the workflow log. It then runs the same dry-run
fallback, prints a clear operator notice, and exits successfully without
publishing. The
`@sekiban/dcb-domain 0.1.1` working changelog entry is included in the GitHub release
notes, while the package tarball remains limited to `dist/**`, `README.md`,
`LICENSE`, and `package.json`. The preflight guard documents a 1,000,000-byte
unpacked-size ceiling for the current neutral bundle (the observed 0.1.0
dry-run is recorded in the SDT-G59 evidence).

After a real publish, the operator verifies the package page on
npmjs.com, the `0.1.1` version, public access, and the provenance badge before
announcing the release.

## Matched core/domain/client release

Issue #120's post-W177 gate recovery uses the working matched `0.1.1` set in dependency order:
`@sekiban/dcb-core`, `@sekiban/dcb-domain`, then `@sekiban/dcb-client`.
The tag-triggered workflow is `.github/workflows/release-dcb-matched-set.yml`
and the exact tag is `dcb-v0.1.1`. It runs `npm run test:g28` and the complete
matched-set build, tarball and consumer proof before any publish step. It then
reads the repository's live `.private` value through the GitHub API. For a
public repository the credential-free proof is one `npm publish --dry-run
--provenance --access public` invocation per package; for this private
repository it is one `npm publish --dry-run --access public` invocation per
package, with `NPM_CONFIG_PROVENANCE=false` in the private publish environment
to prevent npm's GitHub Actions auto-provenance behavior. Because the package
manifests also carry a public-release `publishConfig.provenance` setting, the
private branch removes that field from each package in the isolated checkout
with `npm pkg delete publishConfig.provenance` and verifies it is absent before
publishing by parsing that package's `package.json`. A command-shape guard proves both branches and rejects a private
command mutated to include `--provenance`.

The operator chooses exactly one activation branch: register npm trusted
publishing for the workflow filename `release-dcb-matched-set.yml` and set
`NPM_TRUSTED_PUBLISHING=true`, or provide the operator-managed `NPM_TOKEN`
secret. The later operator commands are:

```sh
git tag dcb-v0.1.1
git push origin dcb-v0.1.1
# public repository:
(cd packages/dcb-core && npm publish --provenance --access public)
(cd packages/dcb-domain && npm publish --provenance --access public)
(cd packages/dcb-client && npm publish --provenance --access public)
# private repository (the W177 path; remove static provenance and keep it disabled):
(cd packages/dcb-core && npm pkg delete publishConfig.provenance && NPM_CONFIG_PROVENANCE=false npm publish --access public)
(cd packages/dcb-domain && npm pkg delete publishConfig.provenance && NPM_CONFIG_PROVENANCE=false npm publish --access public)
(cd packages/dcb-client && npm pkg delete publishConfig.provenance && NPM_CONFIG_PROVENANCE=false npm publish --access public)
```

The workflow itself selects exactly one branch, so operators must not append
`--provenance` to the private path; they must retain
`NPM_CONFIG_PROVENANCE=false` for that path because npm can otherwise infer
provenance in GitHub Actions. It retains the two approved credential
branches: trusted publishing registered for `release-dcb-matched-set.yml`
with `NPM_TRUSTED_PUBLISHING=true`, or an operator-managed `NPM_TOKEN`.

This implementation checkpoint performs none of those tag or publish actions.

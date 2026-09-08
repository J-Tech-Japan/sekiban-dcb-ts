# npm release process

This repository releases `@sekiban/dcb-domain` from a version-matching tag.
The release workflow runs the package build, tarball allowlist guard, clean
consumer proof, typecheck and tests before it reaches the publish step.

## Operator setup

Use one of these authentication paths in the `J-Tech-Japan/sekiban-dcb-ts`
repository; the implementation child does not create or handle either
credential:

1. Register the npm trusted publisher for this repository and the workflow
   file `.github/workflows/release-dcb-domain.yml`. Trusted publishing uses
   GitHub Actions OIDC and the workflow's `id-token: write` permission.
2. As the documented fallback, add an `NPM_TOKEN` repository secret and set
   the repository variable `NPM_TRUSTED_PUBLISHING` only when trusted
   publishing is configured. The workflow uses the secret only for the
   operator-triggered tag run.

## Release steps

The operator verifies the dry-run PR and then runs:

```sh
git tag dcb-domain-v0.1.0
git push origin dcb-domain-v0.1.0
```

The tag workflow checks that the tag matches `packages/dcb-domain/package.json`,
creates the GitHub release notes from `CHANGELOG.md`, runs the clean consumer
proof, and publishes with:

```sh
npm publish --provenance --access public
```

If neither trusted publishing nor `NPM_TOKEN` is configured, the workflow
instead runs `npm publish --dry-run --provenance --access public`, prints a
clear operator notice, and exits successfully without publishing. The
`@sekiban/dcb-domain 0.1.0` changelog entry is included in the GitHub release
notes, while the package tarball remains limited to `dist/**`, `README.md`,
`LICENSE`, and `package.json`. The preflight guard documents a 1,000,000-byte
unpacked-size ceiling for the current neutral bundle (the observed 0.1.0
dry-run is recorded in the SDT-G59 evidence).

After a real publish, the operator verifies the package page on
npmjs.com, the `0.1.0` version, public access, and the provenance badge before
announcing the release.

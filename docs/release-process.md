# npm release process

The matched release workflow is
`.github/workflows/release-dcb-matched-set.yml`. It builds and checks the
dependency-ordered public set before any publish command:

1. `@sekiban/dcb-core`
2. `@sekiban/dcb-domain`
3. `@sekiban/dcb-client`
4. `@sekiban/dcb-runtime`

The workflow selects exactly one authentication mode from the same product
selection code that is checked in the repository:

1. `NPM_TRUSTED_PUBLISHING=true` selects `trusted-publishing` first. The
   publish command runs with GitHub Actions OIDC and explicitly removes
   `NODE_AUTH_TOKEN` from that command, even if an old `NPM_TOKEN` secret is
   still present.
2. Otherwise, a non-empty `NPM_TOKEN` selects `token`.
3. If neither is configured, the workflow reports
   `authentication branch: credential-free-dry-run`, records that no package
   was published, and keeps the credential-free `npm publish --dry-run`
   proof as the fallback.

The maintainer must not append a fourth path or make the fallback look like a
successful release.

## Trusted-publisher registration

The four matched-set packages already exist on the npm registry, and each
needs its own trusted-publisher registration. Register the publisher
separately on each package's npm access page:

- [`@sekiban/dcb-core` access settings](https://www.npmjs.com/package/@sekiban/dcb-core/access)
- [`@sekiban/dcb-domain` access settings](https://www.npmjs.com/package/@sekiban/dcb-domain/access)
- [`@sekiban/dcb-client` access settings](https://www.npmjs.com/package/@sekiban/dcb-client/access)
- [`@sekiban/dcb-runtime` access settings](https://www.npmjs.com/package/@sekiban/dcb-runtime/access)

On each page, open **Trusted publishing**, choose **GitHub Actions**, and enter
these exact values:

| npm field | Value |
| --- | --- |
| Organization or user | `J-Tech-Japan` |
| Repository | `sekiban-dcb-ts` |
| Workflow filename | `release-dcb-matched-set.yml` |
| Environment name | leave empty |
| Allowed action | allow direct `npm publish` for this workflow |

npm asks for the workflow filename, not the full
`.github/workflows/release-dcb-matched-set.yml` path. The workflow already has
`id-token: write` and `contents: read`, which are the required GitHub Actions
permissions for trusted publishing. See the [npm trusted publishing
documentation](https://docs.npmjs.com/trusted-publishers/) for the npm-side
form and OIDC model.

After all four matched-set registrations succeed, set the repository Actions
variable `NPM_TRUSTED_PUBLISHING` to the exact string `true`:

1. Open the repository on GitHub.
2. Go to **Settings → Secrets and variables → Actions → Variables**.
3. Add or edit repository variable `NPM_TRUSTED_PUBLISHING` with value `true`.
4. Leave `NPM_TOKEN` in place only until the first maintainer-controlled release
   has verified the trusted branch; then delete the `NPM_TOKEN` repository
   secret from **Settings → Secrets and variables → Actions → Secrets**.

This implementation does not register publishers, set variables, delete
secrets, push tags, or publish packages.

### Starter-package registration

The starter packages use a separate trusted-publisher registration. Register
each publisher on its package access page:

- [`@sekiban/dcb-cloudflare` access settings](https://www.npmjs.com/package/@sekiban/dcb-cloudflare/access)
- [`@sekiban/create-dcb` access settings](https://www.npmjs.com/package/@sekiban/create-dcb/access)

On each page, open **Trusted publishing**, choose **GitHub Actions**, and enter
these exact values:

| npm field | Value |
| --- | --- |
| Organization or user | `J-Tech-Japan` |
| Repository | `sekiban-dcb-ts` |
| Workflow filename | `publish-dcb-unpublished.yml` |
| Environment name | leave empty |
| Allowed action | allow direct `npm publish` for this workflow |

The starter packages are registered with `publish-dcb-unpublished.yml`, not
`release-dcb-matched-set.yml`. npm requires a newly created trusted-publisher
configuration to complete its first successful publish within two days or it
expires, so register each starter package's publisher shortly before
dispatching its first later version. If a configuration expires, delete it
and recreate it before retrying.

## Starter packages

`@sekiban/dcb-cloudflare` and `@sekiban/create-dcb` are published through
`.github/workflows/publish-dcb-unpublished.yml`. When either starter package
is selected, the workflow runs `npm run test:starter-cold-install` before any
publish command. The gate proves creation, installation, typechecking, and a
Wrangler dry-run from packed artifacts outside the repository.

Both starter packages exist on npm. Their first versions, `0.1.0`, were
published by a maintainer from a local checkout, carry no provenance, and stay
unchanged because published versions are immutable. The normalized bin paths
and provenance therefore first reach npm in a later version. Trusted
publishing requires an existing npm package, so the first publish of any new
package remains a maintainer-controlled action.

For a later starter release, use this procedure:

1. In a reviewed pull request, bump the version of each starter package being
   released and update `package-lock.json`. If the new
   `@sekiban/dcb-cloudflare` version is outside the range declared for it in
   `packages/create-dcb/template/package.json`, update that range, bump
   `@sekiban/create-dcb`, and release both packages. The pre-publish check
   rejects a generated dependency range that the packed helper version does
   not satisfy.
2. After the pull request is merged, dispatch
   `.github/workflows/publish-dcb-unpublished.yml` with the `packages` input
   naming the package directories to release, for example
   `dcb-cloudflare create-dcb`.
3. Verify that the workflow builds, runs the pack-mode starter cold-install
   check before any publish command, and publishes in allowlist order:
   `dcb-cloudflare` before `create-dcb`. A version already on npm is skipped
   rather than republished, so a dispatch without a version bump publishes
   nothing. After publishing, the workflow waits up to about three minutes for
   each new version to be readable from the npm registry. A failure there comes
   after the publish step completed: the version may still be propagating or
   the registry read may have failed, so check
   `npm view <package>@<version> version` and re-dispatch only if the version is
   absent.
4. Verify that the log contains
   `authentication branch: trusted-publishing (GitHub Actions OIDC; NPM_TOKEN omitted)`
   and that each newly published version, not `0.1.0`, shows provenance on its
   npm page. Then run:

   ```sh
   npm run test:starter-cold-install -- --source registry
   ```

Starter-package releases use manual workflow dispatch with the `packages`
input; there is no starter-package tag procedure.

## Visibility-driven provenance policy

The workflow reads the repository's live visibility value and uses it as the
only source for the provenance branch. For a public source repository, the
publish arguments include `--provenance`. For a non-public source repository,
the publish arguments omit `--provenance`, set `NPM_CONFIG_PROVENANCE=false`,
and remove `publishConfig.provenance` from the isolated publish checkout.
npm does not accept provenance bundles for a non-public source repository;
omitting it is deliberate, not a token or trusted-publisher decision.

## Release verification

After registration and the variable change, the maintainer may perform the
normal tag-triggered release using the existing matched-set tag procedure:

```sh
git tag dcb-v0.2.0
git push origin dcb-v0.2.0
```

Before treating that run as trusted publishing, verify all of the following in
the GitHub Actions log:

- the run is the `Release matched DCB package set` workflow for the expected
  `dcb-v*` tag;
- the selection step reports `authMode: trusted-publishing` with
  `tokenConfigured: false` after `NPM_TOKEN` has been removed, or the publish
  step reports `authentication branch: trusted-publishing (GitHub Actions
  OIDC; NPM_TOKEN omitted)` while the secret still exists for the first
  verification;
- no `authentication branch: token` or credential-free fallback line appears;
- the repository-visibility log and publish command match the visibility
  policy above; and
- each of the four package pages shows the newly published version. Public
  source repositories should show npm provenance; non-public source
  repositories should not, because npm does not generate provenance for them.

If the run reports `authentication branch: credential-free-dry-run`, the
workflow intentionally published nothing. Fix the repository variable or
trusted-publisher registration before retrying; do not interpret a green
dry-run-only job as a release.

## Legacy domain-only workflow

The older `.github/workflows/release-dcb-domain.yml` remains a separate
single-package workflow. Its existing token/trusted-publisher branch is not
the matched-set path described above. Do not use its
`release-dcb-domain.yml` filename when registering the four matched-set
publishers.

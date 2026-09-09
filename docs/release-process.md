# npm release process

The matched release workflow is
`.github/workflows/release-dcb-matched-set.yml`. It builds and checks the
dependency-ordered public set before any publish command:

1. `@sekiban/dcb-core`
2. `@sekiban/dcb-domain`
3. `@sekiban/dcb-client`

The workflow selects exactly one authentication mode from the same product
selection code that is guarded by `npm run test:g72:trusted-publishing`:

1. `NPM_TRUSTED_PUBLISHING=true` selects `trusted-publishing` first. The
   publish command runs with GitHub Actions OIDC and explicitly removes
   `NODE_AUTH_TOKEN` from that command, even if an old `NPM_TOKEN` secret is
   still present.
2. Otherwise, a non-empty `NPM_TOKEN` selects `token`.
3. If neither is configured, the workflow reports
   `authentication branch: credential-free-dry-run`, records that no package
   was published, and keeps the credential-free `npm publish --dry-run`
   proof as the fallback.

The operator must not append a fourth path or make the fallback look like a
successful release.

## Trusted-publisher registration

The packages must already exist on the npm registry before npm will allow a
trusted publisher to be registered. All three matched packages already exist
there at `0.1.0` (the matched release prepared by this repository is `0.1.1`).
Register the publisher separately on each package's npm access page:

- [`@sekiban/dcb-core` access settings](https://www.npmjs.com/package/@sekiban/dcb-core/access)
- [`@sekiban/dcb-domain` access settings](https://www.npmjs.com/package/@sekiban/dcb-domain/access)
- [`@sekiban/dcb-client` access settings](https://www.npmjs.com/package/@sekiban/dcb-client/access)

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

After all three registrations succeed, set the repository Actions variable
`NPM_TRUSTED_PUBLISHING` to the exact string `true`:

1. Open `J-Tech-Japan/sekiban-dcb-ts` on GitHub.
2. Go to **Settings → Secrets and variables → Actions → Variables**.
3. Add or edit repository variable `NPM_TRUSTED_PUBLISHING` with value `true`.
4. Leave `NPM_TOKEN` in place only until the first operator-controlled release
   has verified the trusted branch; then delete the `NPM_TOKEN` repository
   secret from **Settings → Secrets and variables → Actions → Secrets**.

This implementation does not register publishers, set variables, delete
secrets, push tags, or publish packages.

## Visibility-driven provenance policy

The workflow reads the repository's live `.private` value with:

```sh
gh api "repos/${GITHUB_REPOSITORY}" --jq '.private'
```

That runtime value is the only source for the provenance branch. For a public
source repository, the publish arguments include `--provenance`. For the
current private source repository, the publish arguments omit `--provenance`,
set `NPM_CONFIG_PROVENANCE=false`, and remove `publishConfig.provenance` from
the isolated publish checkout before running npm. npm rejects provenance
bundles for private source repositories; omitting it is therefore deliberate,
not a token or trusted-publisher decision. A hard-coded public or private
visibility mutant is red in the G72 guard.

## Operator verification

After registration and the variable change, the operator may perform the
normal tag-triggered release using the existing matched-set tag procedure:

```sh
git tag dcb-v0.1.1
git push origin dcb-v0.1.1
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
- the repository-visibility log and publish command match the private/public
  policy above; and
- each of the three package pages shows the newly published version. Public
  source repositories should show npm provenance; private source repositories
  should not, because npm does not generate provenance for private source
  repositories.

If the run reports `authentication branch: credential-free-dry-run`, the
workflow intentionally published nothing. Fix the repository variable or
trusted-publisher registration before retrying; do not interpret a green
dry-run-only job as a release.

## Legacy domain-only workflow

The older `.github/workflows/release-dcb-domain.yml` remains a separate
single-package workflow. Its existing token/trusted-publisher branch is not
the matched-set path described above. Do not use its
`release-dcb-domain.yml` filename when registering the three matched-set
publishers.

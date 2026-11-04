# npm release process

The tag-triggered matched release workflow is
`.github/workflows/release-dcb-matched-set.yml`. A `dcb-v*` tag invokes
`scripts/dcb-matched-set-publish.mjs`, which attempts the dependency-ordered
public set:

1. `@sekiban/dcb-core`
2. `@sekiban/dcb-domain`
3. `@sekiban/dcb-client`
4. `@sekiban/dcb-runtime`

That attempt publishes core, domain, and client. It is expected to stop when
it attempts runtime, because runtime's trusted publisher is registered to
`publish-dcb-unpublished.yml`, not to the tag workflow. The stop is the
expected handoff only when the exact core, domain, and client versions are
visible in the registry and the failing step and package are the runtime
publish with the trusted-publisher authentication mismatch. A missing earlier
package, or a failure before the runtime attempt, is an earlier failure.

A same-tag rerun is appropriate only to recover an earlier transient failure
before that handoff. After the rerun, check the three exact registry versions
again and identify the failing step and package. Once core, domain, and client
are visible, do not rerun the tag for the expected runtime stop. Dispatch
`.github/workflows/publish-dcb-unpublished.yml` with `packages=dcb-runtime`.
Wait for the exact runtime version, then dispatch the same workflow with
`packages=dcb-cloudflare`, wait for the helper, dispatch it with
`packages=create-dcb`, and wait for the creator. The final check is the
registry cold install. This document describes that route. It does not publish,
push a tag, or dispatch a workflow.

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
needs its own trusted-publisher registration. Core, domain, and client are
registered to the tag workflow. Runtime is registered to
`publish-dcb-unpublished.yml`, the same workflow filename used by the helper
and the creator. Register the publisher separately on each package's npm
access page:

- [`@sekiban/dcb-core` access settings](https://www.npmjs.com/package/@sekiban/dcb-core/access)
- [`@sekiban/dcb-domain` access settings](https://www.npmjs.com/package/@sekiban/dcb-domain/access)
- [`@sekiban/dcb-client` access settings](https://www.npmjs.com/package/@sekiban/dcb-client/access)
- [`@sekiban/dcb-runtime` access settings](https://www.npmjs.com/package/@sekiban/dcb-runtime/access)

On the core, domain, and client pages, open **Trusted publishing**, choose
**GitHub Actions**, and enter these exact values:

| npm field | Value |
| --- | --- |
| Organization or user | `J-Tech-Japan` |
| Repository | `sekiban-dcb-ts` |
| Workflow filename | `release-dcb-matched-set.yml` |
| Environment name | leave empty |
| Allowed action | allow direct `npm publish` for this workflow |

On the runtime page, use the same organization, repository, empty environment,
and allowed action, with this workflow filename:

| npm field | Value |
| --- | --- |
| Workflow filename | `publish-dcb-unpublished.yml` |

npm asks for the workflow filename, not the full
`.github/workflows/` path. Both workflows already have `id-token: write` and
`contents: read`, which are the required GitHub Actions permissions for
trusted publishing. See the [npm trusted publishing
documentation](https://docs.npmjs.com/trusted-publishers/) for the npm-side
form and OIDC model. Do not register runtime to `release-dcb-matched-set.yml`.

After the core, domain, and client registrations and the runtime registration
succeed, set the repository Actions variable `NPM_TRUSTED_PUBLISHING` to the
exact string `true`:

1. Open the repository on GitHub.
2. Go to **Settings → Secrets and variables → Actions → Variables**.
3. Add or edit repository variable `NPM_TRUSTED_PUBLISHING` with value `true`.
4. Leave `NPM_TOKEN` in place only until the first maintainer-controlled release
   has verified the trusted branch; then delete the `NPM_TOKEN` repository
   secret from **Settings → Secrets and variables → Actions → Secrets**.

This change does not register publishers, set variables, delete secrets, push
tags, or publish packages.

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

The starter packages, like runtime, are registered with
`publish-dcb-unpublished.yml`, not `release-dcb-matched-set.yml`. npm requires
a newly created trusted-publisher configuration to complete its first
successful publish within two days or it expires, so register each starter
package's publisher shortly before dispatching its first later version. If a
configuration expires, delete it and recreate it before retrying.

## Starter packages

`@sekiban/dcb-cloudflare` and `@sekiban/create-dcb` are published through
`.github/workflows/publish-dcb-unpublished.yml`, after runtime has been
published through that same workflow. When either starter package is selected,
the workflow runs `npm run test:starter-cold-install` before any publish
command. The gate proves creation, installation, typechecking, and a Wrangler
dry-run from packed artifacts outside the repository.

The creator template carries the byte-checked copy of the shared offline
validation core through its existing `template/` package allowlist. The current
`@sekiban/create-dcb` `0.2.0` candidate ships that file. Its generated project
pins the matched set at the candidate version and permits
`@sekiban/dcb-cloudflare` from the candidate helper range. Publish the helper
before the creator, using the sequence below. This document does not publish
either package.

Both starter packages exist on npm. Their first versions, `0.1.0`, were
published by a maintainer from a local checkout, carry no provenance, and stay
unchanged because published versions are immutable. The normalized bin paths
and provenance therefore first reach npm in a later version. Trusted
publishing requires an existing npm package, so the first publish of any new
package remains a maintainer-controlled action.

For the current `0.2.0` candidate release, use this procedure. Versions stay
manifest-derived; do not type a target version into a workflow.

1. In a reviewed pull request, bump the version of each starter package being
   released and update `package-lock.json`. If the new
   `@sekiban/dcb-cloudflare` version is outside the range declared for it in
   `packages/create-dcb/template/package.json`, update that range, bump
   `@sekiban/create-dcb`, and release both packages. The pre-publish check
   rejects a generated dependency range that the packed helper version does
   not satisfy.
2. After the pull request is merged, push the matched-set tag. The tag workflow
   attempts core, domain, client, and runtime through
   `dcb-matched-set-publish.mjs`. Derive the exact versions from the manifests
   and use bounded exact-version polling:

   ```sh
   matched_version="$(node -p "require('./packages/dcb-core/package.json').version")"
   cloudflare_version="$(node -p "require('./packages/dcb-cloudflare/package.json').version")"
   create_version="$(node -p "require('./packages/create-dcb/package.json').version")"

   wait_for_exact() {
     name="$1"
     version="$2"
     for attempt in $(seq 1 36); do
       if [ "$(npm view "${name}@${version}" version 2>/dev/null)" = "$version" ]; then
         return 0
       fi
       if [ "$attempt" -eq 36 ]; then
         echo "${name}@${version} was not visible after 36 attempts" >&2
         return 1
       fi
       sleep 5
     done
   }

   for name in @sekiban/dcb-core @sekiban/dcb-domain @sekiban/dcb-client; do
     wait_for_exact "$name" "$matched_version"
   done
   ```

   Confirm that those three exact versions are visible and that the failing
   step and package are the runtime publish with the trusted-publisher
   authentication mismatch. That is the expected handoff. A missing earlier
   package, or a failure before the runtime attempt, is an earlier failure:
   rerun the same tag only for that transient case, then re-check the three
   versions and the failing step. Do not dispatch runtime, the helper, or the
   creator until that check passes.
3. Dispatch `.github/workflows/publish-dcb-unpublished.yml` with
   `packages=dcb-runtime` only. After that dispatch, wait for the exact runtime
   version before continuing:

   ```sh
   wait_for_exact @sekiban/dcb-runtime "$matched_version"
   ```

4. Dispatch the same workflow with `packages=dcb-cloudflare` only. After that
   dispatch, wait for the exact helper version before continuing:

   ```sh
   wait_for_exact @sekiban/dcb-cloudflare "$cloudflare_version"
   ```

5. Dispatch the same workflow again with `packages=create-dcb` only. After
   that dispatch, wait for the exact creator version, then run the registry
   cold install:

   ```sh
   wait_for_exact @sekiban/create-dcb "$create_version"
   npm run test:starter-cold-install -- --source registry
   ```

   Each starter dispatch builds and runs the pack-mode starter cold-install
   check before any publish command. A version already on npm is skipped rather
   than republished, so a dispatch without a version bump publishes nothing.
   After publishing, the workflow waits up to about three minutes for the
   selected version to be readable from the npm registry. A failure there comes
   after the publish step completed: check `npm view <package>@<version> version`
   and re-dispatch only if the version is absent.
6. Verify that the log contains
   `authentication branch: trusted-publishing (GitHub Actions OIDC; NPM_TOKEN omitted)`
   and that each newly published version, not `0.1.0`, shows provenance on its
   npm page. The tag run's log covers core, domain, and client. The runtime,
   helper, and creator logs come from their `publish-dcb-unpublished.yml`
   dispatches.

Starter-package releases use manual workflow dispatches with the `packages`
input; there is no starter-package tag procedure. The creator is never
dispatched until the helper's exact version is registry-visible, and the
helper is never dispatched until runtime's exact version is registry-visible.

If the tag workflow partially publishes before a later package becomes
visible, identify the failing step before choosing a recovery. Do not begin
the runtime, helper, or creator dispatch while an earlier package is missing.
A same-tag rerun is only for an earlier transient failure before the runtime
handoff. The publisher verifies the exact published prefix and skips each
already-published package whose tag provenance or packed integrity matches,
then continues with the first absent package. It fails on a mismatch rather
than republishing an immutable version; resolve that mismatch before retrying.
After the rerun, re-check the three exact core, domain, and client versions
and the failing step and package. Once those three versions are visible and
the failing step is the runtime publish, do not rerun the tag. Dispatch
`publish-dcb-unpublished.yml` with `packages=dcb-runtime`, wait for runtime,
then dispatch `packages=dcb-cloudflare` and `packages=create-dcb` with an
exact-version wait after each.

## Visibility-driven provenance policy

The workflow reads the repository's live visibility value and uses it as the
only source for the provenance branch. For a public source repository, the
publish arguments include `--provenance`. For a non-public source repository,
the publish arguments omit `--provenance`, set `NPM_CONFIG_PROVENANCE=false`,
and remove `publishConfig.provenance` from the isolated publish checkout.
npm does not accept provenance bundles for a non-public source repository;
omitting it is deliberate, not a token or trusted-publisher decision. The same
provenance rule applies to the tag workflow and to each
`publish-dcb-unpublished.yml` dispatch.

## Release verification

After registration and the variable change, the maintainer may perform the
normal tag-triggered release using the existing matched-set tag procedure:

```sh
version="$(node -p 'require("./packages/dcb-core/package.json").version')"
git tag "dcb-v${version}"
git push origin "dcb-v${version}"
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
  policy above;
- the core, domain, and client package pages show the newly published version;
  and
- the runtime publish is the failing step, with the trusted-publisher
  authentication mismatch, and the three earlier exact versions are visible.
  That stop is the expected handoff. Continue with
  `publish-dcb-unpublished.yml` and `packages=dcb-runtime`, then the helper and
  creator dispatches, and apply the same authentication and provenance checks
  to each of those logs. A public source repository should show npm provenance
  on each newly published version; a non-public source repository should not,
  because npm does not generate provenance for it.

If the run reports `authentication branch: credential-free-dry-run`, the
workflow intentionally published nothing. Fix the repository variable or
trusted-publisher registration before retrying; do not interpret a green
dry-run-only job as a release. Do not treat a failure before the runtime
attempt as the expected handoff.

## Legacy domain-only workflow

The older `.github/workflows/release-dcb-domain.yml` remains a separate
single-package workflow. It is not the four-package tag attempt above, and it
is not the expected runtime handoff to `publish-dcb-unpublished.yml`. Its
existing token/trusted-publisher branch is not the matched-set path described
above. Do not use its `release-dcb-domain.yml` filename when registering core,
domain, or client, and do not use it for runtime, the helper, or the creator.
Runtime, the helper, and the creator use `publish-dcb-unpublished.yml`.

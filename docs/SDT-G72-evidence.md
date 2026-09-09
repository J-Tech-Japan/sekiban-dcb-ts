# SDT-G72 trusted publishing evidence

This document records the implementation proof for issue #148. It does not
publish a package, push a tag, create or delete a credential, or change
repository visibility.

## Contract and source

- Base: origin/main at 82501b8 when the dedicated branch was created.
- Branch: claude/sdt-g72-trusted-publishing-w183.
- The issue was claimed before branch creation with:
  
  ~~~text
  intent-cli worker claim --kind issue --number 148 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write --format json
  ~~~

  The observed result was proceed=true, applied=true, and
  add_labels=["intent-issue-in-progress"].

The product selection is scripts/g72-trusted-publishing-selection.mjs. The
release workflow executes it after the live repository-visibility query and
consumes its GitHub step outputs. The same exported functions are exercised by
scripts/g72-trusted-publishing-guard.mjs, so the proof is not a copied shell
decision.

## AC1/AC2 — authentication selection

Executed:

~~~text
npm run test:g72:trusted-publishing
~~~

The guard passed these selections from the shared product function:

~~~text
trusted publisher selected without token           -> trusted-publishing
token selected when trusted publisher unavailable  -> token
credential-free dry-run without either             -> credential-free-dry-run
trusted publisher wins when legacy token present   -> trusted-publishing
~~~

The CLI invocation representing the real trusted branch was also executed
without a token:

~~~text
env -u NODE_AUTH_TOKEN NPM_TRUSTED_PUBLISHING=true REPO_IS_PRIVATE=false \
  node scripts/g72-trusted-publishing-selection.mjs
~~~

Observed result:

~~~json
{
  "authMode": "trusted-publishing",
  "provenanceEnabled": true,
  "unsetNodeAuthToken": true,
  "willPublish": true,
  "tokenConfigured": false
}
~~~

The workflow trusted branch invokes env -u NODE_AUTH_TOKEN ... npm publish; the
token branch requires a non-empty inherited NODE_AUTH_TOKEN; the third branch
emits authentication branch: credential-free-dry-run and no package was
published after the existing dry-run step.

The mutation runner executed against the product source and ran the guard in a
fresh process for each mutation. Every mutant was red:

| Mutant | Result |
| --- | --- |
| no-auth-publishes | red |
| ignore-true-trusted-publishing | red |
| ignore-available-token | red |
| hard-code-public-provenance | red |

The runner output was result: all-product-mutants-red. Its --self-test also
passed, confirming one exact product-source target per mutation.

The existing credential-free matched-set dry-run was executed in both policy
shapes:

~~~text
NPM_CONFIG_CACHE=/private/tmp/sdt-g72-w183-npm-cache \
  npm run test:g64:publish-dry-run
~~~

and

~~~text
NPM_CONFIG_CACHE=/private/tmp/sdt-g72-w183-npm-cache \
  node scripts/dcb-matched-set-publish-dry-run.mjs --repository-private
~~~

Both exited 0 for all three packages. The public invocation used npm publish
--dry-run --provenance --access public; the private invocation used npm publish
--dry-run --access public with the private provenance environment. No real npm
publish was executed.

## AC3 — runtime visibility and provenance

The workflow still obtains the policy input from the live repository response:

~~~sh
repository_private="$(gh api "repos/GITHUB_REPOSITORY" --jq '.private')"
~~~

The product matrix observed:

~~~text
private source: provenanceEnabled=false, NPM_CONFIG_PROVENANCE=false
public source:  provenanceEnabled=true,  publish environment={}
~~~

The private branch keeps the existing isolated-checkout cleanup of
publishConfig.provenance, while the public branch adds --provenance. A
hard-coded-public provenance mutant was red. The existing G64 command-shape
guard also passed and retained the private no-provenance mutation rejection.

The private case exists because npm rejects provenance bundles for private
source repositories; the workflow therefore disables npm's implicit
GitHub-Actions provenance behavior and removes the publish-only manifest field
in that isolated checkout. This policy is independent of whether trusted
publishing or a token authenticates the publish.

## AC4 — operator procedure

docs/release-process.md contains the standalone procedure. It names these npm
access pages:

- @sekiban/dcb-core — https://www.npmjs.com/package/@sekiban/dcb-core/access
- @sekiban/dcb-domain — https://www.npmjs.com/package/@sekiban/dcb-domain/access
- @sekiban/dcb-client — https://www.npmjs.com/package/@sekiban/dcb-client/access

For each page it specifies GitHub Actions, organization/user J-Tech-Japan,
repository sekiban-dcb-ts, and filename-only workflow value
release-dcb-matched-set.yml (not the .github/workflows/ path). It specifies
the repository variable NPM_TRUSTED_PUBLISHING=true, removal of NPM_TOKEN after
trusted-path verification, the prerequisite that all three packages already
exist on npm, and the exact log/package-page verification steps.

Registry checks confirmed the prerequisite without publishing:

~~~text
@sekiban/dcb-core@0.1.0  -> 0.1.0
@sekiban/dcb-domain@0.1.0 -> 0.1.0
@sekiban/dcb-client@0.1.0 -> 0.1.0
~~~

## AC5 — no-auth outcome

The no-auth product plan is authMode=credential-free-dry-run and
willPublish=false. The release step does not enter either publish loop and
prints both the authentication branch and no package was published, so a
green dry-run-only run cannot be mistaken for a release.

## AC6 — local verification and boundaries

Executed successfully in the dedicated worktree:

~~~text
NPM_CONFIG_CACHE=/private/tmp/sdt-g72-w183-npm-cache npm ci
npm run test:g72:trusted-publishing
npm run test:g64
npm run lint
npm run typecheck
actionlint .github/workflows/ci.yml .github/workflows/release-dcb-matched-set.yml
git diff --check
~~~

npm run test:g64 passed its matched-set build, tarball, consumer, tag-shape,
publish-shape and dry-run gates. No dependency or lockfile diff was created;
the package script addition only exposes the new guard to CI. No release,
version, tag, credential, or publish operation was performed.

The broad npm test sweep was also run. It reached 89 passed test files and 790
passed tests, but reproduced six existing timing/alarm failures in G43, G67,
commit AC7, repair, and Tag G5 under the local workerd environment. No G72
source is in those failures, and no timeout or test relaxation was added.

## Official operator reference

The npm registration and OIDC requirements are documented at
https://docs.npmjs.com/trusted-publishers/. The implementation deliberately
stops before the operator-only registration, secret removal, tag, and publish
boundaries.

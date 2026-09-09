# SDT-G72 trusted publishing deadline handoff — W183

Task: SDT-G72-TRUSTED-PUBLISHING-DEADLINE-W183  
Issue: https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/148  
Pull request: https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/150  
Branch: claude/sdt-g72-trusted-publishing-w183  
Base: origin/main at 82501b8  
Pushed implementation head: 7e81cd4a88cbb10bcd1ad11932d0c353712e35a7

## Priority preservation

Before taking the single implementation seat, the in-flight G70 worktree was
checked and its durable checkpoint was pushed:

- Branch: claude/sdt-g70-allocator-closed-prefix-w176
- Exact pushed checkpoint: 0b6153c3abd7ece30c5ebea5e4a81a0c080d6b63
- G70 remains paused. It was not resumed while G72 was in progress.

G72 was claimed with the canonical worker command:

~~~text
intent-cli worker claim --kind issue --number 148 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write --format json
~~~

The claim returned proceed=true, applied=true, and added
intent-issue-in-progress.

After PR creation, the canonical worker result was recorded with:

~~~text
intent-cli worker complete --kind issue --number 148 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --outcome pr-created --pr 150 --write --format json
~~~

It applied intent-pr-created and removed the in-progress issue label. The
child worktree reported linked_pr_synced=false with the expected host/review
runtime follow-up warning; the PR itself is open and ready for review.

## Acceptance contract and implementation

The implementation preserves the existing NPM_TRUSTED_PUBLISHING branch and
runtime repository-visibility provenance policy. Authentication selection is
implemented once in scripts/g72-trusted-publishing-selection.mjs and both the
release workflow and the guard execute that product code.

| Acceptance criterion | Implementation and proof |
| --- | --- |
| AC1 — select trusted publishing when enabled | NPM_TRUSTED_PUBLISHING=true selects trusted-publishing before any token. The release branch explicitly runs env -u NODE_AUTH_TOKEN ... npm publish, so a legacy token cannot silently authenticate that branch. |
| AC2 — retain token fallback and prove branch selection | A configured token selects token only when trusted publishing is unavailable. The guard covers trusted/no-token, token/no-trusted, no-auth, and trusted-with-token cases. The mutation runner proves each decision is live product behavior. |
| AC3 — preserve runtime visibility/provenance policy | The workflow obtains repository_private from gh api repos/$GITHUB_REPOSITORY --jq '.private'. Public repositories publish with --provenance; private repositories set NPM_CONFIG_PROVENANCE=false and retain the isolated publish-checkout manifest cleanup. |
| AC4 — document operator registration and verification | docs/release-process.md gives the three npm access pages, GitHub Actions provider, J-Tech-Japan, sekiban-dcb-ts, filename-only release-dcb-matched-set.yml, the NPM_TRUSTED_PUBLISHING=true repository variable, legacy-token removal timing, and exact log/provenance/package-page verification. |
| AC5 — no-auth behavior is safe | With neither trusted publishing nor a token, the selected mode is credential-free-dry-run, willPublish=false, and the workflow prints the branch and no package was published without entering a publish loop. |
| AC6 — boundaries and verification | No package was published, no tag was created, no credential was read or changed by the operator, and no package/version/release dependency change was made. Local and hosted G72-specific gates are recorded below. |

The issue package prerequisite was checked without publishing:

~~~text
@sekiban/dcb-core@0.1.0  -> 0.1.0
@sekiban/dcb-domain@0.1.0 -> 0.1.0
@sekiban/dcb-client@0.1.0 -> 0.1.0
~~~

The existing G64 matched-set dry-run and command-shape contract remain in
place; G72 only adds the shared authentication-selection guard and workflow
branch selection around them.

## Selection proof and behavioral mutants

npm run test:g72:trusted-publishing passed the shared product matrix:

~~~text
trusted publisher selected without token          -> trusted-publishing
token selected when trusted publisher unavailable -> token
credential-free dry-run without either            -> credential-free-dry-run
trusted publisher wins when legacy token present   -> trusted-publishing
~~~

The real trusted-path CLI invocation was run without a token and returned:

~~~json
{
  "authMode": "trusted-publishing",
  "provenanceEnabled": true,
  "unsetNodeAuthToken": true,
  "willPublish": true,
  "tokenConfigured": false
}
~~~

The mutation runner changes the actual product module and launches a fresh
guard process for every mutation. Its self-test passed, and all four
behavioral mutants were red:

| Mutant | Expected failure |
| --- | --- |
| no-auth-publishes | red |
| ignore-true-trusted-publishing | red |
| ignore-available-token | red |
| hard-code-public-provenance | red |

The normal result was all-product-mutants-red; the source is restored in a
finally block. This proves the trusted branch is selected by the product
decision rather than by a test-only copy or an unconditional workflow branch.

## Operator registration and verification

The operator-only steps are documented, not executed by this task. For each
package, open its npm access page:

- https://www.npmjs.com/package/@sekiban/dcb-core/access
- https://www.npmjs.com/package/@sekiban/dcb-domain/access
- https://www.npmjs.com/package/@sekiban/dcb-client/access

Register a trusted publisher on each page with:

1. Provider: GitHub Actions.
2. Organization/user: J-Tech-Japan.
3. Repository: sekiban-dcb-ts.
4. Workflow filename: release-dcb-matched-set.yml (filename only, not the
   .github/workflows/ path).
5. Environment: blank.
6. Allow direct npm publish, as required by the npm trusted-publisher form.

All three packages must already exist on npm. Then, in the repository Actions
variables, set NPM_TRUSTED_PUBLISHING to the exact string true. Retain the
legacy NPM_TOKEN secret only until the first operator-controlled trusted
verification, then delete that secret from the repository Actions secrets.

For verification, run the matched-set release workflow manually and confirm
the log contains the trusted-publishing branch and the three package publish
steps, contains no token value, and shows public --provenance when the live
repository is public. Confirm each npm package page shows the new version and
trusted-publisher provenance. If the source repository is private, confirm the
private policy instead: no --provenance, NPM_CONFIG_PROVENANCE=false, and the
publish-only manifest cleanup.

Reference: https://docs.npmjs.com/trusted-publishers/.

## Local evidence

All commands below were run in the dedicated G72 worktree. A temporary npm
cache was used only to avoid a root-owned default-cache permission error.

| Command | Result |
| --- | --- |
| NPM_CONFIG_CACHE=/private/tmp/sdt-g72-w183-npm-cache npm ci | pass |
| npm run test:g72:trusted-publishing | pass; matrix, real CLI, self-test, and four red mutants |
| npm run test:g64 | pass; matched build, tarball, consumer, tag-shape, publish-shape, and dry-run gates |
| npm run test:g64:publish-shape | pass |
| NPM_CONFIG_CACHE=/private/tmp/sdt-g72-w183-npm-cache npm run test:g64:publish-dry-run | pass for all three packages; public dry-run includes --provenance |
| NPM_CONFIG_CACHE=/private/tmp/sdt-g72-w183-npm-cache node scripts/dcb-matched-set-publish-dry-run.mjs --repository-private | pass for all three packages; private dry-run omits provenance |
| npm run lint | pass |
| npm run typecheck | pass |
| actionlint .github/workflows/ci.yml .github/workflows/release-dcb-matched-set.yml | pass |
| git diff --check | pass |

The broad npm test sweep was not claimed green: 89 test files and 790 tests
passed with one skipped, while six existing timing/alarm failures reproduced
in G43, G67, commit AC7, two repair tests, and Tag G5 under the local workerd
environment. No G72 source failed, and no test was relaxed or bypassed.

## Hosted status

The implementation commit triggered:

- CI run 34321638086: https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34321638086
- Release preflight run 34321638108: https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34321638108

At the latest observation while preparing this handoff:

| Check | Status |
| --- | --- |
| ci-g64 (includes the G72 guard) | pass |
| dcb-domain-release-preflight | pass |
| Most other completed CI jobs | pass |
| ci-g43 | fail; the known ambient scheduler/alarm baseline failure, outside G72 |
| ci-g30-core, ci-g30-forced-red, ci-g32-parity | still pending/in progress at the latest poll |

Therefore this report does not claim a fully green aggregate run. The G72
selection/provenance gate and release preflight are passing, the implementation
is pushed and review-ready for issue #148, and the remaining red/pending status
is explicitly preserved for orchestration review rather than hidden or
worked around.

## Scope boundary

The branch contains only the G72 workflow/product guards, CI wiring, operator
documentation, and evidence documentation. No production compatibility
bypass, test-host bypass, test relaxation, package/release change, publish,
tag, or credential operation was performed. G70 remains paused at the exact
checkpoint recorded at the top of this report.


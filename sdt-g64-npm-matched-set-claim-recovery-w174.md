# SDT-G64-NPM-MATCHED-SET-CLAIM-RECOVERY-W174

Status: completed — ready-for-review PR created; npm publication remains
operator-only.

## Handoff identity

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- Issue: [#120](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/120)
- Branch: `claude/sdt-g64-npm-matched-set-claim-recovery-w174`
- Implementation checkpoint: `e0ffe8c`
- Boundary compatibility repair: `9da054d5c175d2374ed3ffa81ac885dfc436bbee`
- Evidence/report follow-up is committed after `9da054d`; the final branch SHA
  is the exact SHA reported with this artifact.
- Host claim consumed (not reacquired): execution-unit `SDT-G64`, commit
  `1f42126e5767c4cc56876e729832c9ec69091252`, verified
  `passed=true/status=owned`, holder `implementation`, team
  `sekiban-dcb-ts-orch`.
- The earlier duplicate target-label claim was not retried or bypassed.

## PR and lifecycle

- Ready, non-draft PR: [#139](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/139)
- PR base: `main`
- PR body contains `Closes #120`.
- `intent-cli worker result-summary --kind issue-to-pr --issue 120 --pr 139
  --repo J-Tech-Japan/sekiban-dcb-ts --pr-draft false --outcome pr-created
  --format json`: completed, evidence gap empty, ready for review.
- `intent-cli worker complete --kind issue --number 120
  --repo J-Tech-Japan/sekiban-dcb-ts --github-only --outcome pr-created
  --pr 139 --write --format json`: applied; source issue state is
  `intent-target` + `intent-pr-created`. The CLI reported
  `linked_pr_synced=false` as a host-owned follow-up; no host state was
  touched from this child.

## Implemented scope

The matched public set is `@sekiban/dcb-core`, `@sekiban/dcb-domain`, and
`@sekiban/dcb-client`, all at `0.1.0`. Core and client now have publishable
metadata, Elastic-2.0 license/readme files, repository metadata, Node engine,
public provenance configuration, explicit exports, and exact package file
allowlists. The client has exact runtime dependencies on core and domain;
there are no workspace/file/link references in published manifests. The
client/core `.js` declaration boundaries make the public executor consumable
under Node16.

Added proofs cover exact `npm pack --dry-run --json` contents and size, clean
outside-workspace Node16 and Bundler consumers, an esbuild consumer bundle,
the V1 serialized command envelope, and negative deep imports. The tag
workflow verifies the tag and runs the domain/matched gates before any publish,
then performs credential-free provenance dry-runs. If an operator supplies
trusted publishing (`NPM_TRUSTED_PUBLISHING=true`, OIDC) or `NPM_TOKEN`, it
publishes in core → domain → client order; otherwise it exits after dry-run.

## Receipts

Local focused gates, using only a temporary npm cache because the host cache is
root-owned:

| Command | Result |
| --- | --- |
| `NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64` | PASS: build/pack/consumer/release order; Node16, Bundler, esbuild green; 9 expected red probes detected |
| `NPM_CONFIG_CACHE=... SDT_G64_FORCE_FAILURE=1 npm run test:g64:forced-red` | Expected inner exit 1; forced-red guard did not escape |
| `NPM_CONFIG_CACHE=... npm run lint` | PASS |
| `NPM_CONFIG_CACHE=... npm run typecheck` | PASS |
| `NPM_CONFIG_CACHE=... npm run test:boundaries` | PASS after the narrow G13 contract repair |
| `NPM_CONFIG_CACHE=... npm run test:g28` | PASS, 20/20 |
| `NPM_CONFIG_CACHE=... npm run test:g59` | PASS, pack + consumer |
| `node scripts/g40-ci-coverage-check.mjs` | PASS; `ci-g64` is in the inventory and `verify.needs` |
| `git diff --check` / staged diff check | PASS |

The first PR run was not misreported as green. Run
`34253795826`, `ci-local-e2e` job
`102154365473`, failed only at `npm run test:boundaries` because the old G13
fixture expected client dependencies to be core-only. Store/D1 steps passed.
The narrow repair `9da054d` changes that assertion to require exactly the
matched core/domain pair, not arbitrary dependencies; the focused boundary
lane passes afterward. The replacement exact-head hosted run is recorded as
pending/in progress at handoff, with `ci-g64` already successful on the prior
PR head; no hosted failure is called green.

The repository-wide `npm test` was run unchanged and returned 6 failed, 88
passed, 1 skipped test files and 7 failed, 789 passed, 1 skipped tests. Its
failures were the known local timing/runner signatures in allocation
cancellation, G43 measurement spread, G43 AC6 alarm re-arm, the unchanged G67
5,000ms guard, repair scan/re-query timeouts, and G5 timeout, with teardown
and local Hyperdrive messages. No G64 test failed; no test assertion, timeout,
retry, or gate was weakened.

## Operator-only release steps

No npm publish, tag, credentials, deployment, Cloudflare operation, G32
mutation, or runtime API change was performed. After review and merge, an
operator may run:

```sh
git tag dcb-v0.1.0
git push origin dcb-v0.1.0
(cd packages/dcb-core && npm publish --provenance --access public)
(cd packages/dcb-domain && npm publish --provenance --access public)
(cd packages/dcb-client && npm publish --provenance --access public)
```

The approved alternative is the `release-dcb-matched-set.yml` trusted
publisher path with OIDC and `NPM_TRUSTED_PUBLISHING=true`, or the operator's
`NPM_TOKEN`. With neither credential path, the workflow runs only:

```sh
npm publish --dry-run --provenance --access public
```

for each package and performs no publication.

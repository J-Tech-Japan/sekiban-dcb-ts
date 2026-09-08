# SDT-G59-NPM-010-RELEASE-PREP-W172

Status: implementation checkpoint ready for review; npm publish not performed.

## Scope and claim

- Issue: `J-Tech-Japan/sekiban-dcb-ts#124`.
- Branch: `claude/sdt-g59-npm-010-release-prep-w172`.
- Base: `origin/main` at `5b643ef`.
- Implementation source commit: `5294f6666accfc0ba26e81e17562ba1c37f0bf4f`.
- Canonical claim command from this child cwd:
  `intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind issue --number 124 --github-only --write --format json`.
- Claim result: `proceed=true`, `applied=true`, `errors=[]`, and
  `intent-issue-in-progress` was added. No claim bypass or raw label operation
  was used.

## Implemented release preparation

- Public `0.1.0` package manifest with Elastic-2.0 metadata, repository
  directory, Node engine, public/provenance publish configuration, exact `zod`
  dependency, and `dist`/README/license/package allowlist.
- Build-time license copy and Node16-compatible declaration post-processing.
- Strict tarball allowlist/stray-file guard and clean external consumer guard.
- Node16 and bundler consumer compilation/runtime, public surface, testing
  subpath, PortableSnapshot/Session and deep-import rejection proof.
- Tag/version and changelog checks.
- Pull-request preflight workflow and tag-driven provenance release workflow
  with trusted publisher/NPM_TOKEN fallback and no-credential dry-run branch.
- Package install/versioning docs, operator release process, changelog, and
  `docs/SDT-G59-evidence.md`.

## Gates

The focused release gates are green: package build, package typecheck, pack
guard, external consumer guard, G28 compile-fail/boundary guards, lint, root
typecheck/build, tag/version, changelog extraction, and `git diff --check`.
The unchanged repository aggregate has the local C-14-style exception recorded
in `docs/SDT-G59-evidence.md`: after isolated dependency installation it
reported 6 existing test files / 7 tests failing in G43/G67/G6/tag timing
paths, with 88 passed and 1 skipped. No G59 file or assertion caused or altered
those failures, and the aggregate is not called green. Hosted exact-head CI is
required for ready-PR acceptance.

## Operator publish workflow

The implementation did not run npm publish. After hosted CI is green and the
PR is reviewed, the operator configures trusted publishing or `NPM_TOKEN`,
then pushes `dcb-domain-v0.1.0`. The exact publish command is:

```sh
cd packages/dcb-domain
npm publish --provenance --access public
```

The tag workflow repeats the gates and uses that command only when operator
credentials/configuration exists; otherwise it executes the documented
`npm publish --dry-run --provenance --access public` no-publish path.

The final release-prep checkpoint is the pushed branch tip reported with the
canonical completion report. No Cloudflare, deployment, registry, credential,
or resource action was performed.

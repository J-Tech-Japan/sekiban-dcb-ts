# SDT-G59-PR138-W173-F1-TAG-TEST-REPAIR

Status: repair pushed; hosted exact-head CI is required before release.

## Scope and exact source

- PR: `J-Tech-Japan/sekiban-dcb-ts#138`
- branch: `claude/sdt-g59-npm-010-release-prep-w172`
- base: `main`
- reviewed head: `40a7e8814ec60ac32801b938e213008457103cf3`
- exact workflow repair head: `fd5b9a2ec54097d49713a44d0a8c8f549c41f696`
- linked issue: `#124` (`Closes #124` remains unchanged)

The repair is F1-only. It does not change the accepted F2 package-boundary
consumer guards, F3 trusted-publisher/NPM_TOKEN instructions, dry-run proof,
operator-only publish branch, test budgets, product behavior or existing CI
gates.

## F1 repair

`.github/workflows/release-dcb-domain.yml` now logs
`GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW` and the exact command, then
runs `npm run test:g28` after build/typecheck and before pack, release notes,
credential-free dry-run, release creation and the conditional real publish.
The same identity-bearing gate is present in
`.github/workflows/dcb-domain-release-preflight.yml`, so the PR preflight
exercises the same domain suite without credentials. A non-zero suite result
stops the workflow before any publish branch.

`npm run test:g28` is the existing domain suite command:

```text
npm run build:packages && vitest run --config vitest.config.ts test/dcb-domain.spec.ts
```

## Exact-head local receipts

```text
head=fd5b9a2ec54097d49713a44d0a8c8f549c41f696
NPM_CONFIG_CACHE=/tmp/sdt-g59-npm-cache npm run test:g28
PASS — 1 file, 20 tests

NPM_CONFIG_CACHE=/tmp/sdt-g59-npm-cache npm run test:g59
PASS — pack 23 files / 699358 bytes; Node16, Bundler, esbuild and shipped
       deep-import rejection green; stray/private-manifest/deep-import red
       receipts retained with expected reasons

actionlint .github/workflows/release-dcb-domain.yml \
  .github/workflows/dcb-domain-release-preflight.yml
PASS
git diff --check
PASS
```

The tag workflow itself is not run here because no tag or npm publication is
authorized. Its first release-path test step records the tagged commit and
run identity in the hosted log. The preflight provides the credential-free
PR proof; its `GITHUB_SHA` is reported as preflight identity, not substituted
for a tag commit. Exact-head hosted CI for the pushed repair is the remaining
release gate.

No npm publish, tag push, credential creation, deployment, host-state change,
or release credential mutation was performed.

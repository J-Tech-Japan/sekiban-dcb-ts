# SDT-G59-PR138-REVIEW-REPAIR-W172

Status: repair pushed; exact-head hosted CI is to be re-evaluated.

## PR and scope

- PR: `J-Tech-Japan/sekiban-dcb-ts#138`
- Branch: `claude/sdt-g59-npm-010-release-prep-w172`
- Base: `origin/main` at `5b643ef`
- Scoped source repair commit: `8c3341187dff2fc48cb9eb830f33d9af34bd9389`
- Linked issue: `#124` (`Closes #124` remains unchanged)
- No npm publish, tag push, credential creation, deployment, or host-state mutation.

## Review findings repaired

### F1 — release tests and credential-free publish proof

`.github/workflows/release-dcb-domain.yml` now runs `npm run test:g59` after
build/typecheck and before pack/consumer/release/publish steps. It also runs
the exact credential-free command `npm publish --dry-run --provenance --access
public` before the conditional real publish branch, recording `GITHUB_SHA`,
`GITHUB_RUN_ID`, workflow name, command and complete output. The PR preflight
runs the same proof. The real publish branch remains operator-only.

Local proof at the exact source repair head:

```text
head=8c3341187dff2fc48cb9eb830f33d9af34bd9389
run_id=local-2026-09-08
command=npm publish --dry-run --provenance --access public
result: @sekiban/dcb-domain@0.1.0, 23 files, 699.4 kB unpacked,
        shasum 04fb7cfdc2d3d6682d0ed42162dc2366378f8cee,
        dry-run success (+ @sekiban/dcb-domain@0.1.0)
```

### F2 — bundler and C-12 boundaries

`dcb-domain-consumer-check.mjs` now emits and executes the Bundler TypeScript
consumer, creates and executes an esbuild bundle, and checks the shipped
`@sekiban/dcb-domain/dist/index.js` path under both Node16 and Bundler
resolution. Both package-export checks fail as required while the allowed
surface compiles and runs.

The same command retains red-before-green receipts:

- temporary stray package entry: pack guard fails with
  `unexpected package entries: .g59-stray-file-probe`;
- temporary pre-change `private: true`: pack guard fails with
  `package must be public`;
- shipped `dist/index.js` deep import: package exports reject it in Node16 and
  Bundler modes;
- the mutations are restored, followed by the green emitted/compiled/runtime
  and bundle receipts.

### F3 — exact trusted-publishing branches

`docs/release-process.md` now distinguishes the two operator branches:

1. npm trusted publisher for repository `J-Tech-Japan/sekiban-dcb-ts`, workflow
   filename `release-dcb-domain.yml`, plus repository variable
   `NPM_TRUSTED_PUBLISHING=true`;
2. repository secret `NPM_TOKEN` as the fallback.

Both branches retain the exact `dcb-domain-v0.1.0` tag/push procedure and
`npm publish --provenance --access public` command. If neither is configured,
the workflow performs the logged dry-run and exits without publishing.

## Focused verification

```text
npm run test:g59                                  PASS
npm run lint                                      PASS
npm run typecheck --workspace @sekiban/dcb-domain PASS
node scripts/dcb-domain-release-check.mjs ...     PASS
node scripts/dcb-domain-release-notes.mjs ...     PASS
actionlint release/preflight workflows            PASS
git diff --check                                  PASS
```

The pre-existing exact-head CI run was green before this repair; the pushed
repair head must receive a new exact-head CI result. Tests are necessary but
the evidence above also maps each review finding to the release workflow,
consumer boundary, and operator documentation contract.

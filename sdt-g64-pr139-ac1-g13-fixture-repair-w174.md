# SDT-G64-PR139-AC1-G13-FIXTURE-REPAIR-W174

Status: completed — the narrow G13 consumer-fixture contract repair is pushed
to PR #139.

## Head and scope

- PR: [#139](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/139)
- Requested starting head: `21a623630d7d3bc05708a52462322157973e8624`
- Source repair commit: `d5bbd5e77b9a8125cae9ebe88dcf2698f359abdd`
- Branch: `claude/sdt-g64-npm-matched-set-claim-recovery-w174`
- The source change is limited to `scripts/g13-consumer-fixture.mjs`.

## Finding and precise repair

Replacement CI job
[`ci-local-e2e`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34254308746/job/102156134757)
failed because the fixture asserted:

```text
@sekiban/dcb-core must remain private
```

That assertion contradicts issue #120 AC1, which requires the matched release
set's core manifest to be publishable. The fixture now computes the intended
state by package role: `@sekiban/dcb-runtime` must remain private, while
`@sekiban/dcb-core` and `@sekiban/dcb-client` must be publishable. The fixture
still requires ESM, `sideEffects: false`, root exports/types, rejects all
disallowed deep imports, protects explicit runtime Cosmos/D1/MV subpaths,
rejects sample source deep imports, verifies the public runtime registration
API, and retains the tree-shaking check. No guard was removed, generalized,
skipped, retried, or given a larger timeout.

## Focused receipts

All commands used the existing temporary npm cache only:

```text
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:consumer
  PASS — G13/G14/G18/G19 consumer fixture
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:boundaries
  PASS — G13/G14/G12 package boundary fixture
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64:consumer
  PASS — Node16, Bundler and esbuild consumers; expected red probes detected
node scripts/dcb-matched-set-release-check.mjs dcb-v0.1.0
  PASS — core -> domain -> client order
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run lint
  PASS
git diff --check / staged diff check
  PASS
```

The earlier matched-set build/pack/typecheck and G40 receipts remain recorded
in `docs/SDT-G64-evidence.md`. No npm publish, tag, credentials, deployment,
runtime API change, G32 mutation, or host-state operation occurred.

The receipt is committed after the source repair; the exact final branch SHA
is reported with the canonical repair transition.

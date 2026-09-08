# SDT-G64-PR139-AC2-BOUNDARY-REPAIR-W174

Status: completed — the narrow AC2 boundary repair is pushed to PR #139.

## Exact scope and head

- PR: [J-Tech-Japan/sekiban-dcb-ts#139](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/139)
- Requested pre-repair head: `7230a38ff1437c6f2434585dd59bc79234da92e9`
- Repair commit already present on the branch: `9da054d5c175d2374ed3ffa81ac885dfc436bbee`
- Current pushed branch head before this receipt: `c8ffb5cd36b2d673a8df07088c1b8f38831dff85`
- Branch: `claude/sdt-g64-npm-matched-set-claim-recovery-w174`
- No source change beyond the narrow G13 boundary guard repair was made for
  this task.

## Finding and repair

Hosted run `34253795826`, job
`https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34253795826/job/102154365473`
failed `ci-local-e2e` at `npm run test:boundaries` with:

```text
AssertionError: client may depend only on core
actual   ["@sekiban/dcb-core", "@sekiban/dcb-domain"]
expected ["@sekiban/dcb-core"]
```

This was implementation-caused by issue #120 AC2, not an environment-only
exception: the matched release set requires the client to carry exact runtime
dependencies on both `@sekiban/dcb-core@0.1.0` and
`@sekiban/dcb-domain@0.1.0`. `scripts/g13-boundary-check.mjs` now asserts the
exact ordered set
`["@sekiban/dcb-core", "@sekiban/dcb-domain"]` and still rejects every other
dependency. It does not remove the boundary guard, permit arbitrary packages,
or alter a timeout/retry/fixture.

## Verification

Using the existing temporary npm cache only:

```text
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:boundaries  PASS
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64        PASS
```

The matched-set pass includes core/domain/client builds, exact dry-run pack
allowlists and size bounds, clean Node16 and Bundler consumers, esbuild V1
consumer runtime, all expected negative stray/private/deep-import receipts,
and release order core -> domain -> client. Earlier local receipts also show
lint, typecheck, G28, G59, G40 coverage, and diff checks passing. The first
hosted failure's store/D1 steps passed; only the stale boundary assertion
failed. No npm publication, tag, credentials, deployment, Cloudflare/G32
mutation, runtime API change, or manual label operation occurred.

## Lifecycle

The canonical `intent-cli worker complete` repair transition is run for PR
#139 after this receipt is committed and pushed. Any child-cwd
`linked_pr_synced=false` warning remains host-owned and is not repaired from
this worktree.

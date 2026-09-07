# SDT-G69 safety PR — W165

Task: `SDT-G69-SAFETY-PR-W165`

- Issue: #133 (remains open; AC4/AC5 remain outstanding)
- Branch: `claude/sdt-g69-local-ordering-proof-w164`
- W164 source checkpoint: `adfb7b3617ee4e6b1c76399aea0e06ec3d536213`
- Base: `origin/main` / `3f6df6433c6e6cc7e16ea26f0fc8ac32e39f5809`
- Scope: fail-closed lower-SUID detector, lag-estimate blind-spot repair, and
  append-only admission-attempt receipt only.

## Claim and source boundary

Canonical issue claim succeeded from the child worktree:

```text
intent-cli worker claim --kind issue --number 133 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write --format json
proceed=true, applied=true, add_labels=[intent-issue-in-progress], errors=[]
```

The range contains only the W164 safety additions, their real proof/guard,
migration/helper, evidence, and local test configuration. It does not contain a
first-arrival fence, SafeWindow adjustment, retry/drain change, deployment,
production cohort, or G32 change.

## Proof and acceptance disposition

The real allocator→Tag→D1→G44/G62 proof was retained exactly. It reproduced a
live ordering defect: a higher-SUID event reached a real settled/applying safe
pass before a lower-SUID allocator candidate had been durably admitted. The
lower event later triggered `LATE_LOWER_SUID`, an `ORDER_VIOLATION` incident, and
fail-closed safe-lane behavior. No injected `SETTLED` result was used.

The three safety additions are present and guarded:

1. fail-closed late-lower detector;
2. lag estimate no longer skips a lower-SUID observation when a higher SUID is
   present;
3. append-only `recordDelivery` attempt receipt with identity, clocks, status,
   and retry reason.

`npm run test:g69` reports all three mutants red and restored. AC4/AC5 are not
claimed: the first-arrival fence remains deliberately unimplemented and there
was no deployment or production cohort. The PR body uses `References #133`, not
`Closes #133`.

## Local verification

Passing at the exact source:

- `npm run lint`
- `npm run build --workspace @sekiban/dcb-runtime`
- `../node_modules/.bin/vitest run --config vitest.g69.config.ts test/g69-ordering.spec.ts --reporter=dot --testTimeout=30000` (1 file, 2 tests)
- `npm run test:g69` (baseline pass; three mutants exit 1)

The relevant aggregate lanes were executed. `npm run test:g44`, `test:g58`,
`test:g62`, `test:g67`, `test:g61`, `test:g60:required`, `test:g65:required`,
`test:g41`, `test:g43`, `test:g26`, `test:g27`, and `npm run typecheck` stop at
the existing isolated-worktree package-resolution exception before reaching
their assertions. The representative failures are stale parent resolution for
`@sekiban/dcb-client` (`ExecuteCommandResult`, `SnapshotReader.head`) and
missing already-landed G60/G65/G67 exports/options in the meeting-room sample.
These are not masked or called green. The changed runtime package and G69
focused path build/pass independently.

The detailed prior lane record, red/green report, and local coordinator 404/
NOSENTRY environment notes are retained in
`sdt-g69-local-ordering-proof-w164.md` and
`.artifacts/sdt-g69-ordering-red-green.json`.

## Lifecycle handoff

Ready-for-review PR creation is the next step after this evidence commit. Exact
hosted CI must be green before rereview. No review, merge, deployment, resource
cleanup, production operation, or first-arrival-fence implementation is part of
this checkpoint.

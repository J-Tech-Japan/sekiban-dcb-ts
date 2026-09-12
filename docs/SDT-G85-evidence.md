# SDT-G85 evidence

## W255 implementation checkpoint

SDT-G85 repairs the control flow around detached worktree cleanup in
`scripts/ci-local.mjs`. It does not change a manifest command, tier, budget,
service image, workflow schedule, pull-request lane, test body, retry, skip or
flaky annotation. The implementation branch is based on `origin/main` at
`bbfb6b6fcc20de6cbc92fecc12dce0cd98b8ec2e`.

The historical Full CI backstop failure is retained and was not rerun:
[run 34661042762](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34661042762)
reached the eight started lanes, then failed while removing the `local-e2e`
worktree with `error: failed to delete /tmp/sdt-g84-local-e2e-<suffix>:
Directory not empty`. The `cosmos` lane never started and no final per-lane
summary was emitted. No test assertion was reported as failed. This receipt is
historical evidence only.

### AC1 — cleanup outcome is explicit and best-effort

`removeDetachedWorktree` (current source lines 178–254) first attempts
`git worktree remove --force`. If that refuses, or if its post-attempt state is
not clean, it removes the worktree directory and runs `git worktree prune`.
It then checks both the directory and `git worktree list --porcelain`. The
returned cleanup record includes the method (`removed` or `fallback-prune`),
remove/prune status, directory state, registration state and any errors. The
caller marks the lane failed only when cleanup cannot prove
`directoryGone=true` and `worktreeRegistered=false`; worktree creation remains
fatal to that lane.

The record is attached to both `receipt.cleanup` and `receipt.execution.cleanup`
and is written after the cleanup attempt. Consequently, a cleanup refusal
cannot overwrite a green command result or erase its cleanup diagnosis.

### AC2 — every selected lane reaches the summary

`executeSelectedLane` (current source lines 688–812) records command, service
cleanup and worktree-cleanup failures as a lane result. `executeLaneSequence`
(lines 814–832) catches a lane-level exception and continues through the
selected sequence. The final `sdt-ci-local/v1` output now includes a `summary`
row for every selected lane with its lane name, green/failed status, exit
status, error and receipt path. The process still exits nonzero when any lane
fails; the continuation changes control flow, not the lane's own verdict.

### AC3 — semantic self-tests

The existing `node scripts/ci-local.mjs --self-test` surface now runs three
additional semantic checks. They use the same cleanup and lane-sequence
functions as production execution; no test framework was added.

| Case | Proof | Result |
| --- | --- | --- |
| cleanup fallback | A simulated run-created untracked directory makes forced worktree removal refuse; fallback removal plus prune leaves no directory and no registration, and the lane remains green. | green |
| unrecoverable cleanup | A simulated directory and registration deliberately remain after both attempts; the returned cleanup record is not OK and the lane disposition is red. | red-lane |
| lane continuation | A synthetic first lane throws and a later lane runs; the summary contains both `early-failure` and `later-lane`, with failed then green statuses. | failed-after-summary |

The self-test output also retains the pre-existing detached-worktree, isolated
NuGet and container-provenance controls. The current terminal output was:

```text
schema: sdt-ci-local-self-test/v1
manifest: 10
globProof: [true, true, true]
worktreeProof: detached HEAD matches current HEAD; clean=true; dependenciesAreNotImplicitlyCopied=true
nugetProof: variableCount=4; insideWorktree=true
containerProof: healthy=green; aliasOnlyMutation=red
cleanupProof.fallbackRefusal: method=fallback-prune; directoryGone=true; worktreeRegistered=false
cleanupProof.unrecoverableCleanup: directoryGone=false; worktreeRegistered=true; failureReason=directory remains, worktree remains registered
continuationProof.invoked: early-failure, later-lane
continuationProof.summary: failed, green
selfTestCleanup: method=removed; directoryGone=true; worktreeRegistered=false; ok=true
```

Each case is asserted against the semantic boundary: removing the fallback,
accepting an uncleared worktree, or stopping the lane sequence makes the
self-test fail rather than merely changing a label or exit-code heuristic.

### AC4 — unchanged surfaces

The diff is limited to `scripts/ci-local.mjs` and this evidence document.
`ci/lanes.json`, all lane commands and forced-red commands, all tiers and
budgets, service images, schedules and the pull-request workflow remain
unchanged. The prior failure receipt remains historical. No Full CI
workflow-dispatch is performed before this repair is merged; after merge,
exactly one post-repair backstop dispatch is required by AC5.

## Verification and pending hosted receipts

The following focused checks passed at the implementation checkpoint:

```text
node --check scripts/ci-local.mjs                         PASS
npx eslint scripts/ci-local.mjs --max-warnings=0          PASS
node scripts/ci-local.mjs --self-test                    PASS
git diff --check                                          PASS
```

The ready-for-review PR, its exact-head pull-request CI result and its
worker-completion receipt will be appended after publication. The one
post-repair Full CI backstop dispatch is intentionally pending until the PR is
merged; run 34661042762 will not be rerun and no pre-merge Full CI dispatch is
claimed here.

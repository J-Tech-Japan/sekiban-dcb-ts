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

## Verification and hosted PR-tier receipt

The following focused checks passed at the implementation checkpoint:

```text
node --check scripts/ci-local.mjs                         PASS
npx eslint scripts/ci-local.mjs --max-warnings=0          PASS
node scripts/ci-local.mjs --self-test                    PASS
git diff --check                                          PASS
```

The ready-for-review PR is [#172](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/172),
based on `main` at `bbfb6b6fcc20de6cbc92fecc12dce0cd98b8ec2e`. The source
repair head was `dc40f51521ada428bc392c54d008369ac21ef272`; the final evidence
head is `82856d97e15cbd340a66051fd643304fd14850b4`. The branch is
`claude/sdt-g85-ci-local-cleanup-w255`; the base is an ancestor of the head.
The PR body retains `Closes #171`.

The exact-head pull-request workflow
[34671000923](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671000923)
completed successfully at `dc40f51521ada428bc392c54d008369ac21ef272`:

| Job | Receipt | Result |
| --- | --- | --- |
| `ci-foundation` | [103492270830](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671000923/job/103492270830) | success |
| `ci-pr-cheap` | [103492270915](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671000923/job/103492270915) | success |
| `verify` | [103493926406](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671000923/job/103493926406) | success |

The first push's superseded workflow [34670911418](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34670911418)
is historical; the terminal evidence above is the second push's exact-head
workflow. The issue claim was applied before implementation, and the
canonical issue-to-PR completion was recorded immediately after PR creation
with outcome `pr-created` for PR #172. The completion response reported
`proceed=true` and `applied=true`; its host-linkage warning is retained as a
host-owned follow-up rather than represented as implementation evidence.

The final evidence-head pull-request workflow
[34671677008](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671677008)
completed successfully at `82856d97e15cbd340a66051fd643304fd14850b4`:

| Job | Receipt | Result |
| --- | --- | --- |
| `ci-pr-cheap` | [103494066461](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671677008/job/103494066461) | success |
| `ci-foundation` | [103494066576](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671677008/job/103494066576) | success |
| `verify` | [103495903455](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671677008/job/103495903455) | success |

The preceding exact source-head workflow
[34671000923](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34671000923)
at `dc40f51521ada428bc392c54d008369ac21ef272` was also terminal success and
is retained as historical source-head evidence. The initial superseded
[34670911418](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34670911418)
was cancelled; it is not used as a green receipt. The final head differs from
the source repair only by this durable evidence and PR-description update.

No Full CI workflow-dispatch was performed before merge, and the historical
failed backstop [34661042762](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34661042762)
was not rerun. AC5 therefore remains explicitly pending the owner-controlled
merge followed by exactly one post-repair Full CI backstop dispatch. That
dispatch must include Cosmos and publish every lane's result; it is not
claimed by this pre-merge implementation receipt.

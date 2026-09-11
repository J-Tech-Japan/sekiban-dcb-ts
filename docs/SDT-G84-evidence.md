# SDT-G84 evidence

Status: blocked at the local implementation checkpoint. This document records the
bounded evidence collected locally; it does not claim a hosted PR result.

## Head, base, and scope

The implementation branch is `claude/sdt-g84-implementation-w242`. Its source
validation head is `08328f176b5b7f023d1d46569a97e670e8ea9049`, based on current
`origin/main` `247d6d90902cf90cead08835d358e8d0197a297a`. The issue claim for
SDT-G84/#168 was accepted by the GitHub-only worker protocol. No PR was created,
no hosted workflow was started, and no remote branch was pushed during this
local-only continuation.

The change is limited to CI lane configuration, local execution/receipt tooling,
G40/G79 inventory and guard recognition, the G40 baseline inventory, package
scripts, and this evidence. No product source or test body was changed. Existing
G43 coordination, forced-red proofs, timing guards, retries, skips, and unrelated
unit paths remain in scope only as preserved commands/guards.

## Tier manifest and hosted workflow shape

`ci/lanes.json` is the `sdt-ci-lanes/v1` manifest. It declares two PR lanes
(`foundation`, `cheap`), eight local lanes (`g21-g25`, `g32-parity`, `g30`,
`g43`, `g44`, `g46`, `local-e2e`, `cosmos`), and a full tier that includes both
PR and local lanes. It records the pinned `postgres:16-alpine` and Cosmos service
images, lane commands, forced-red commands, and the existing proof commands.

The PR workflow has only `ci-foundation`, `ci-pr-cheap`, and an always-run
`verify` job. It uses concurrency cancellation and the exact guarded ignore path
`docs/SDT-G84-evidence.md`; there is no broad `docs/**` ignore and no schedule in
the PR workflow. `ci-full.yml` is the separate weekly/manual full-suite workflow.
The heavy lanes are invoked by `npm run ci:local` in the local/full tier rather
than by additional PR-hosted jobs.

The G40 coverage check completed with:

```text
tierCounts pr=2 local=8
manifestCommandCount=123
baselineLeafCommandCount=136
currentLeafCommandCount=136
missing=[] additions=[]
prJobs=["ci-foundation","ci-pr-cheap"]
workflowJobs=["ci-foundation","ci-pr-cheap","verify"]
```

The G40 mutation proof rejected both required mutants: removing the required G43
lane and replacing the local lane set with an empty set. The ignored-path check
accepted only the exact evidence file path. The G79 inventory self-test reported
`jobs=3`, `invocations=133`, and retained the reporter/proof classification.

## Local receipts

Receipts are under `.artifacts/ci-local/<commitSha>/` and are intentionally tied
to the source validation head.

| commit | lane | result | receipt facts |
| --- | --- | --- | --- |
| `08328f176b5b7f023d1d46569a97e670e8ea9049` | `g21-g25` | green | exit 0; 573,643 ms; 16 commands; all G21–G25, G54, G56 and G53 normal/forced-red commands completed with the expected statuses |
| `08328f176b5b7f023d1d46569a97e670e8ea9049` | `g32-parity` | failed by environment | exit 1; 517,562 ms; source clone succeeded and the 10-file G32 suite was 50/50 green; the final C# parity command failed before its oracle |

The current G32 receipt is
`.artifacts/ci-local/08328f176b5b7f023d1d46569a97e670e8ea9049/g32-parity.json`.
The final retry used isolated `NUGET_PACKAGES` and `NUGET_HTTP_CACHE_PATH` under
`/private/tmp`; restore then succeeded. The exact terminal blocker was:

```text
CSC : error CS2012: Cannot open
'/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g84-w242/tools/sekiban-parity/obj/Debug/net10.0/SekibanParity.dll'
for writing -- Access to the path ... is denied.
```

The first attempt at the same source head was separately recorded with a shared
NuGet-cache `NU1900` permission failure; the isolated retry removed that cache
failure but exposed the generated-object-directory permission failure above.
Neither failure is a G32 assertion failure.

Historical bounded collection at `4972658b731cb83576bcceaafc22f292d64c4468`
is retained locally: `g21-g25` stopped at the then-stale G53 workflow guard after
its preceding proofs, and `g32-parity` stopped at the then-stale G32 workflow
guard after the parity clone/tests. The initial G30 mutation matrix was started
but intentionally stopped before a lane receipt; therefore no G30 green result
is claimed.

The local full tier is consequently incomplete. In particular, the G30 lane has
no terminal receipt and G32 has an environment failure. This is not converted
into a green result by the successful JavaScript proof commands.

## Preserved failure evidence and cost boundary

The unchanged baseline `npm test` remains a known timing failure: 5 files and 9
tests failed (93 files passed, one skipped; 824 tests passed, one skipped), with
the existing timeout rows in `test/repair.spec.ts` at 434/454/481 and
`test/tag.spec.ts` at 368/401. The run took 62.41 seconds. No G84 timeout,
skip, retry, flaky annotation, product, or test-body change was made to hide it.

Issue #168 records the prior PR cost as approximately 192–202 billable minutes.
No post-change hosted measurement was collected in this local-only continuation,
so no <=20-minute or <$100 claim is made. The hosted before/after acceptance
remains unverified and requires a later authorized exact-head workflow run.

## Disposition

The manifest, PR/full/local workflow shape, local receipt runner, G40 guards,
G79 inventory, and focused local proofs are present at the source validation
head. The implementation is blocked from ready-for-review completion because the
G32 local parity lane is blocked by the generated C# output permission error,
the G30 local lane lacks a terminal receipt, and the current instruction forbids
starting hosted workflows. No PR-created or worker-complete receipt is claimed.

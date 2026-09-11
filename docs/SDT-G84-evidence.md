# SDT-G84 evidence

## W243 hosted attempt and bounded guard repair (2026-09-11)

PR #169 was created from the dedicated branch against `main` at
`247d6d90902cf90cead08835d358e8d0197a297a`. Its first pull-request workflow
attempt was the requested AC2 measurement at source head
`38bee00cc1bae3cc3bf9721c544d5a1f45882f50`:

* CI run [34595766957](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34595766957)
  reached terminal `failure`. `ci-foundation` job `103251031697` was green.
  `ci-pr-cheap` job `103251031529` failed in `Execute manifest PR cheap tier
  and G40 guards`; `verify` job `103254465478` then failed only because the
  PR tier was not green.
* The first actionable error in the cheap-tier receipt was
  `Error: g40-ignored-paths-check:scan failed for
  docs/SDT-G84-evidence.md: spawnSync rg ENOENT`. The new G84 ignored-path
  guard used an optional `rg` executable that is not present on this hosted
  runner. This is a guard portability failure, not a product or test failure;
  no G43/G79 assertion was changed or reclassified.
* Release preflight
  [34595766967](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34595766967)
  was an automatic pull-request run, not a workflow dispatch, and reached
  terminal `success` at the same exact head. Job `103251031426`
  (`dcb-domain-release-preflight`) completed all release/package checks.

The bounded repair replaces the optional `rg` subprocess in
`scripts/g40-ignored-paths-check.mjs` with the checked-out Git index's
fixed-string `git grep`, retaining the exact-path scan, broad-glob rejection,
tracked-file matching, and self-exclusion of the guard itself. It does not
change the workflow, manifest paths, G53/G32 guards, product behavior, tests,
timeouts, retries, skips, or forced-red proofs. Local focused validation at
the repair source includes `node --check`, the guard self-test and normal
scan, and `npm run test:g40:tiers`; all passed. This source repair is the
justified second PR push/run required by AC2; no blind rerun was made.

The repair push produced source head
`1d40779aa6dd447c1bfe33ef96fd5da522968d54`. Its exact-head hosted receipts
are:

* CI run [34597077543](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34597077543)
  reached terminal `success` at that head. `ci-foundation` job
  `103255219348`, `ci-pr-cheap` job `103255219587`, and `verify` job
  `103259270543` all passed. This is the second AC2 hosted attempt, not a
  relabelled first attempt.
* Release preflight run
  [34597077499](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34597077499)
  reached terminal `success` at the same head in
  `dcb-domain-release-preflight` job `103255218706`. This was the automatic
  pull-request preflight, not a workflow-dispatch run.

No hosted workflow was rerun after these terminal results, and no release
preflight workflow dispatch was started. The first post-merge full workflow
dispatch remains `pending` and `not collected`.

## W243 pre-PR implementation checkpoint (historical, 2026-09-11)

This is the W243 continuation of the W242 checkout. The current source
validation commit is `9e7e8579096b6b30c82fb8c20bcb175af69eeb3a` on
`claude/sdt-g84-implementation-w242`, based on current `origin/main`
`247d6d90902cf90cead08835d358e8d0197a297a`. The branch is not yet represented
by a PR at this checkpoint; no hosted workflow has been started. The prior W242
claim was already in progress: the required GitHub-only issue claim was retried
and returned `proceed=false`, `applied=false`, with the exact stale-claim error
`claim.stale.already-in-progress: issue already carries 'intent-issue-in-progress'.`
No label was manually changed. This is retained as a protocol receipt, not a
successful new claim.

W243 contains only the G84 CI/lane work. The bounded post-W242 commits are:

* `489f452` isolates the G32 parity compiler invocation.
* `b8cb771` preserves the G32 build-shape oracle while adding the lane's
  in-process switches.
* `89be104` serializes the parity restore/build path and records the required
  settings in the receipt.
* `9e7e857` wires the existing G43 forced-red command to its required manifest
  environment (`SDT_G43_FORCE_FAILURE=1`); it does not alter G43 production code,
  test assertions, coordination, budgets, or timing guards.

The stale G53 and G32 workflow guards remain present and now recognize their
manifest-owned commands; neither guard was deleted. The exact source diff has
no product-source or test-body changes. Existing G73/G43 behavior and every
forced-red proof remain intact.

### Current local receipts

The receipts below are the observed terminal results. A receipt's `commitSha`
is its actual source identity; the later evidence-only commit will not be
silently relabelled as an execution receipt.

| Source receipt | Lane | Result | Evidence |
| --- | --- | --- | --- |
| `89be104e0c7b87533a24850cd9fe95f97bd9cb72` | `g32-parity` | green | `.artifacts/ci-local/89be104e0c7b87533a24850cd9fe95f97bd9cb72/g32-parity.json`; exit 0, 989,468 ms; source clone, 10-file G32 suite, real parity command and forced-red command all had expected results |
| `89be104e0c7b87533a24850cd9fe95f97bd9cb72` | `g30` | green | `.artifacts/ci-local/89be104e0c7b87533a24850cd9fe95f97bd9cb72/g30.json`; exit 0, 3,257,578 ms; uninterrupted normal G30, G51, candidate proof and forced-red proof completed |
| `9e7e8579096b6b30c82fb8c20bcb175af69eeb3a` | `g43` | blocked | `.artifacts/ci-local/9e7e8579096b6b30c82fb8c20bcb175af69eeb3a/g43.json`; normal `npm run test:g43` exited 1 after 11,944 ms at the existing `test/g43-measurement.spec.ts:276` assertion (`commit.rowsRead all-points spread: expected 33 to be <= 2`). This is preserved G43/G79 measurement evidence; W243 does not repair or weaken it. |
| `9e7e8579096b6b30c82fb8c20bcb175af69eeb3a` | `g44` | green | `.artifacts/ci-local/9e7e8579096b6b30c82fb8c20bcb175af69eeb3a/g44.json`; exit 0, 483,682 ms; normal G44/G75/G58/G62/G67/G61 commands and all expected red mutations passed |
| `9e7e8579096b6b30c82fb8c20bcb175af69eeb3a` | `g46` | green | `.artifacts/ci-local/9e7e8579096b6b30c82fb8c20bcb175af69eeb3a/g46.json`; exit 0, 298,781 ms; G46/G49 normal and expected forced-red commands passed |
| `9e7e8579096b6b30c82fb8c20bcb175af69eeb3a` | `local-e2e` | green | `.artifacts/ci-local/9e7e8579096b6b30c82fb8c20bcb175af69eeb3a/local-e2e.json`; exit 0, 81,045 ms; store, D1, MV, boundaries, consumer, build, G15 and G16 local paths passed |
| `9e7e8579096b6b30c82fb8c20bcb175af69eeb3a` | `cosmos` | blocked by environment | `.artifacts/ci-local/9e7e8579096b6b30c82fb8c20bcb175af69eeb3a/cosmos.json`; exit 128 after 1,022 ms. The first retained-history command failed before the Cosmos tests with `fatal: remote error: upload-pack: not our ref 38219c8a6526a0209295e9f06450cce9e2217005`. This is an unavailable remote object/reference, not a Cosmos assertion; no retry was made. |

The W243 run did not rerun unchanged `g21-g25`; the W242 `g21-g25` receipt
remains historical at `08328f176b5b7f023d1d46569a97e670e8ea9049`. Therefore the
current source head does not yet have a complete all-local-lane green receipt.
The generated G79 timing logs from the G43 attempts were moved to the local
temporary evidence directory and are not claimed as tracked source changes.

The G32 receipt records all three required in-process settings in both its
`environment` and `buildSettings` objects:

```text
UseSharedCompilation=false
MSBUILDDISABLENODEREUSE=1
DOTNET_CLI_USE_MSBUILD_SERVER=0
```

NuGet restore succeeded with isolated `NUGET_PACKAGES` and
`NUGET_HTTP_CACHE_PATH` directories. No `dotnet build-server shutdown` and no
process kill was run; no CS2012 failure persisted. The G30 elapsed time was
3,257,578 ms (about 54m18s), below the required two-times threshold of 82–90
minutes derived from the 41–45 minute CI reference. It is not flagged as over
twice the reference.

### Verification and disposition

`npm run test:g40:tiers`, lint, typecheck, the G32 runner/oracle and focused
package checks passed at the source-equivalent W243 commits. The G40 structural
check reported `pr=2`, `local=8`, `manifestCommandCount=123`, unchanged
baseline/current leaf inventory `136/136`, and no missing or added historical
commands; PR jobs remain `ci-foundation` and `ci-pr-cheap`, with `verify` as the
aggregator. The G79 inventory self-test reported three workflow jobs, 133
manifest/workflow invocations, 73 reporter-classified per-test invocations and
60 proof-only invocations.

The W243 implementation is not claimed complete: the current G43 measurement
assertion is a real preserved lane failure, Cosmos cannot resolve a pinned
historical object from the remote, and current-head g21-g25 evidence is absent.
These findings are outside the permitted G84 calibration scope. The next
authorized step is the requested ready-for-review PR and its exact-head hosted
pull-request measurement; no release-preflight workflow-dispatch run is to be
started before merge. The first post-merge full workflow-dispatch run is
`pending`, not collected.

Status: blocked at the local implementation checkpoint. This document records the
bounded evidence collected locally; it does not claim a hosted PR result.

## W242 historical head, base, and scope

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

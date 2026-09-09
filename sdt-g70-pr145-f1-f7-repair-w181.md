# SDT-G70 PR145 F1-F7 repair — W181

Task: `SDT-G70-PR145-F1-F7-REPAIR-W181`

Base reviewed head: `4bdea14d5ff8bcbf03d5adb0e304d712eef33fee`

Implementation commit: `29327a5` (`fix(g70): close F1-F7 allocator authority gaps`)

Scope: G70 allocator closed-prefix authority only, with the required affected
G58/G69 regression and evidence updates. No package/release, deployment,
resource, production, G32, #133, merge, or review-state operation was done.
Pre-existing unrelated artifact and fixture modifications remain unstaged.

## F1-F7 / AC1-AC8 disposition

- F1 / AC1: temporary Tag repair fences are no longer issuance closure facts;
  only installed membership, a durable Tag tombstone, or an explicit allocator
  `revoked` disposition can close a target. A writer-authority check rejects a
  delayed exact identity after revocation/fencing, so clearing a temporary
  fence cannot reopen it. Status-only and unreadable cancellation/fence bodies
  are not accepted as closure evidence.
- F2 / AC2 and AC5: recovery work is atomically indexed by due time, bounded
  to 32 records per alarm, fair across the schedule, and preserves an earlier
  alarm. A finite vanished-writer grace boundary creates identity-bound
  revocation facts; a due-time continuation drains beyond one page. The public
  AC1 test covers a new-partition vanished writer without a manual replacement
  append, and the AC2/AC5 test resolves a permanent Tag fact beyond one page.
- F3 / AC1, AC3, and AC6: only a genuinely empty allocator namespace can
  establish its first membership cut. Existing state, metadata, vectors,
  index, watermark, bootstrap seed, and legacy obligations remain
  unreconciled. `/reconcile-cut` requires bounded complete identity coverage,
  service binding for participant-bearing history, and an explicit legacy
  membership proof when an old vector omitted target membership. A legacy
  lower vector followed by a higher public commit remains blocked before the
  cut and closes only after membership import plus vanished-writer resolution.
- F4 / AC3 and AC4: safe projection/MV application in the allocator-bound
  worker requires a cached allocator-transaction certificate bound to the
  consumer service and allocator lineage. Omitted, unreconciled, foreign
  service, or foreign lineage certificates fail closed; the public on-demand
  path does not add a remote allocator fetch.
- F5 / AC4 and AC7: closed-prefix advancement is bounded to 64 records and
  reconciliation cuts to 256 records (with conservative continuation or
  rejection). Durable-write timing is measured after the storage transaction
  resolves. The public cost test compares matched baseline and healthy,
  participant-bearing operations and records certificate acquisition and safe
  application timing.
- F6 / AC1-AC5 and AC8: the public matrix covers complete, lower-hole,
  partial, lost-cancellation, temporary-fence, expired-writer, migration,
  fresh-activation, and safe-application outcomes. Direct Tag calls are used
  only as an explicit delayed-writer/recovery seam; ordinary commit and safe
  application assertions use the public/runtime path. The new behavioral
  runner rebuilds and tests four real product mutants against the public
  oracle.
- F7 / AC4 and AC8: the all-tag safe poll propagates `maximumSuid` and the
  G58 W104 guard has an explicit all-tag omission mutant.

## Local evidence

All commands below ran in the preserved `.g70-w176` worktree after the final
source repair (the G70/allocator suite was rerun after the fresh-namespace
guard was added):

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| G70 + allocator focused Vitest (`test/g70-allocator-closed-prefix.spec.ts test/allocator.spec.ts`) | 20/20 pass (15 + 5) |
| G70 source guard self-test/run | 12/12 source mutants red; pass |
| G70 real-product mutation runner | 4/4 behavioral mutants red; pass |
| G58 focused Vitest | 16/16 pass |
| G58 W104 all-tag guard self-test/run | pass |
| G69 focused Vitest | 8/8 pass; deliberate ordering witness remains `BLOCK/UNSETTLED` before late-lower quarantine |
| `test/commit.spec.ts` + `test/repair.spec.ts` | 18/18 pass (9 + 9) |
| `npm run build:packages --silent` | pass |
| `git diff --check` | pass before commit |

The repository-wide parallel `npm test` is not claimed green; the prior
environmental G43 teardown/measurement and unrelated short test-timeout
behavior remains documented without changing assertions or timeout policy.

## Completed-operation cost samples

Observed in the public AC7 test with participant-bearing obligations and one
safe-applied event per row:

| obligations | baseline response ms | healthy response ms | safe application ms | safe applied | acquisition ms | durable write ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 38 | 31 | 0 | 1 | 0 | 1 |
| 8 | 36 | 321 | 0 | 1 | 0 | 0 |
| 32 | 53 | 2840 | 0 | 1 | 1 | 1 |

These are local observations, not SLO thresholds. The observed maximum
healthy response was 2840 ms; acquisition and durable-write costs were at
most 1 ms, and safe application was 0 ms at millisecond-clock resolution.

## Hosted status

The exact repair commit was pushed after this checkpoint. Hosted PR/check
status is recorded by the final orchestration report and must be interpreted
against the final branch head, not the old reviewed head. No hosted green
claim is made here until that status is queried.

## Changed evidence files

- [docs/SDT-G70-evidence.md](docs/SDT-G70-evidence.md)
- [scripts/g70-allocator-closed-prefix-mutation-runner.mjs](scripts/g70-allocator-closed-prefix-mutation-runner.mjs)
- [test/g70-allocator-closed-prefix.spec.ts](test/g70-allocator-closed-prefix.spec.ts)

The sender report uses the canonical `intent-cli notify report` command with
this artifact as its final payload.

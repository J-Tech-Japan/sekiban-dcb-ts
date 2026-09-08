# SDT-G69 PR136 F1/F2/F3/F5 repair — W166-2

Status: repair pushed; exact-head CI is required before rereview.

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: #136, branch `claude/sdt-g69-local-ordering-proof-w164`
- Reviewed starting head: `965ade8fb60b94674d2db246bb0da000ef1dfacb`
- Scoped repair source head: `b8fef5f` (`fix(g69): harden ordering quarantine and diagnostics`)
- Scope: G69 only. No deployment, Wrangler, Cloudflare/resource, production,
  G32, fence, SafeWindow, retry, drain, allocator-closure, or #133 closeout
  action was performed.

## Semantic repair

- F1: `findLateLowerSuidEvidence` accumulates unknown/untrusted clock and
  provenance observations while continuing the scan. A later independently
  proven Queue/fast late-lower event wins over an earlier unknown row. Replay,
  equal-millisecond arrival, decreasing-timestamp `MIN`, overwrite, rollback,
  imported/repaired provenance, invalid generation and delayed admission are
  covered without claiming an order proof.
- F2: every `waitFor` unavailable/timeout and read-boundary race rechecks the
  durable ordering quarantine. If quarantine caused the safe-read
  unavailability, the public response is typed HTTP 503
  `projection_ordering_quarantined`; unsafe reads remain available. Safe rows,
  `readHead`, active generation and page generation are tied to one validated
  generation and a generation change returns retryable 503 rather than mixed
  data.
- F3: promotion proof is no longer a caller-supplied positive row count. The
  real rebuild path captures complete source event IDs/SUIDs, max SUID and a
  history digest before and after catch-up, binds the proof to the durable
  quarantine incident and generation, invalidates it on any later apply, and
  allows a complete legitimate empty materialized result. Incomplete,
  fabricated, stale, wrong-generation, or offending-history-missing proof is
  rejected. Promotion resolves only the matching older incident atomically.
- F5: the admission attempt receipt is best effort and non-blocking for core
  admission. It records observed before/after clocks, nullable actual Queue
  wrapper identity, honest observation consistency, and mutation-owned
  `first-admission`/`duplicate-admission`/`unverified` labels. Duplicate is
  never inferred from a diagnostic pre-read; failed, concurrent, replayed and
  late diagnostic observations remain explicit. Retention remains bounded to
  512 rows per service.

The six SDT-G60 mutants remain unchanged. The first-arrival fence, SafeWindow,
retry/drain behavior, and allocator closure are not implemented or redefined.
The structural allocator witness remains qualified as local evidence, not a
production incident, and issue #133 remains open with AC4/AC5 outstanding.

## Local verification

Passing focused checks:

- `npx vitest run test/g69-ordering.spec.ts --pool=forks --maxWorkers=1
  --no-file-parallelism`: 5/5.
- `npx vitest run test/g31-waitfor.spec.ts test/g55-read-visibility.spec.ts
  --pool=forks --maxWorkers=1 --no-file-parallelism`: 30/30.
- `npm run test:g69`: green; all four G69 mutants red.
- `npm run test:g44`: 8/8 and G44 production mutants red.
- `npm run test:g43`: 20/20 and five production mutants red; known G43
  crash/teardown diagnostics were emitted by the runner but the command
  exited 0.
- `npm run test:g60:required`: direct 14/14, unsafe-writer 4/4, Queue,
  durable-hop and post-admission guards green; all six unchanged G60 mutants
  red.
- `npm run test:g61`, `npm run test:g62`, and `npm run test:g65`: green
  guards with their required pre-fix/mutant probes red; G65 had 17/17 tests.
- Serialized `npx vitest run test/g67-safe-lane.spec.ts --pool=forks
  --maxWorkers=1 --no-file-parallelism`: 11/11. The normal parallel
  `npm run test:g67` aggregate timed out its cron-disabled paced test at
  5,004 ms and recorded the expected red mutant probes; this remains an
  environment/runner exception and is not called green.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: pass.

The cache-corrected full aggregate
`NPM_CONFIG_CACHE=/private/tmp/sdt-g69-npm-cache npm run check` passed lint,
typecheck and all G28 boundary gates, then stopped in default-parallel
`npm test`: 90 files passed, 4 failed, 1 skipped; 788 tests passed, 5 failed,
1 skipped. The failures were the existing timing/teardown signatures in
`test/commit.spec.ts` AC7, `test/g67-safe-lane.spec.ts` AC3,
`test/repair.spec.ts` (the 15-second crash/race sweep and 5-second checkpoint),
and `test/tag.spec.ts` G5. No G69 assertion failed and no timeout, fixture or
acceptance gate was changed.

`npm run test:g58` reached the existing W96 diagnosis exception
`same-tick frontier witness remains red (exit null)` and was not called green.
The known stale-parent isolated-worktree package-resolution exception
(`ExecuteCommandResult`, `SnapshotReader.head`, and landed G60/G65/G67
exports/options) remains separately reported. Unrelated historical fixture and
artifact dirt was preserved and is not part of this checkpoint.

The immutable receipt is committed with the repair evidence; the final exact
branch head and hosted CI conclusion are supplied by the canonical lifecycle
report after the required exact-head run settles.

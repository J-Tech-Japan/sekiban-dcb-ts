# SDT-G67 local checkpoint

This document is the deploy-free AC1–AC3/local-AC6 checkpoint for issue #129.
It does not claim the same-arm AC4 or production AC5 deployment proof; those
remain for the separately delegated continuation. No Wrangler, Cloudflare,
reset, deployment, resource, or PR operation was used here.

## Source and process

- Base: `origin/main` at `868f2fc` after `git fetch origin`.
- Branch: `claude/sdt-g67-local-wake-w142`.
- Host execution-unit claim: supplied evidence says owned by
  `codex-net-orchestration / sekiban-dcb-ts-orch`, host commit
  `4e3a34fd2aa6b140d3ae431793e3c30b44d27dfb`.
- Child claim command was attempted before editing:
  `intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind issue --number 129 --github-only --write --format json`.
  It made no change because the issue already carried `intent-issue-in-progress`;
  the exact result was `proceed=false`, `applied=false`, error
  `claim.stale.already-in-progress: issue already carries 'intent-issue-in-progress'.`
  No raw label operation was used.
- The standalone issue URL was unavailable through the web cache in this
  environment; the checked-in SDT-G67 packet was used as the local contract.

## Implementation

`handleDownstreamQueue` now exposes a Queue-only stored-delivery hook. It is
called after a stored `recordDelivery` result has selected its Queue ack/retry
disposition, including a G44 completeness failure, and is not called after a
record-delivery failure. The sample callback only calls `waitUntil`.

`createSafeLaneKickScheduler` provides per-service single flight plus one
coalesced rerun. The kick first runs a fresh
`GlobalCompletenessReconciler.reconcile`, then uses
`runMeetingRoomScheduledMaintenance`, so coverage, retained-frontier fencing,
unsafe-kick draining, and both materialized-view catch-up paths remain shared
with cron. The cron hook remains the backstop and records its existing health
history; kicks emit an observation-only `safe_lane_pass` log with
`trigger=kick`.

## Red/green evidence

The required guard is `scripts/g67-safe-lane-guard.mjs`. It preserves the
following receipts:

- `test/fixtures/g67-red-before-green.json`: both the omitted-kick mutant and
  the frontier-omission mutant were red before the normal oracle was accepted.
- `test/fixtures/g67-green.json`: AC1–AC3 focused tests passed.
- `test/fixtures/g67-mutants-red.json`: both mutants remained red after the
  implementation.

The AC1 focused file also contains a concurrent-kick oracle: three deliveries
share one service scheduler, the first pass is held open, and the coalesced
rerun observes the same final head. The observed maximum active pass count is
`1`, the pass count is `2` (initial pass plus one coalesced rerun), and both
recorded heads are identical.

The package lane is:

```text
npm run test:g67
```

It runs the focused Vitest file, unique-anchor self-test, red-before-green
receipt, green tests, and both mutation receipts. The local CI workflow now
invokes this lane in the existing G44 lane and adds a forced-red reachability
probe; existing gates were not removed, weakened, or timeout-inflated.

## AC3 local proof

`test/g67-safe-lane.spec.ts` drives ten logical commits at 10,000 ms spacing
with cron disabled. Each commit schedules the actual exported kick scheduler;
the injected pass calls the existing `runMeetingRoomScheduledMaintenance`
body with a settled frontier and records the resulting safe head. The test
asserts ten safe heads, ten delivery-to-safe intervals of 25 ms, ten pass-body
runs, and zero cron invocations. The compact per-commit table is:

| commit | logical delivery time | logical safe time | delivery→safe | safe head |
|---:|---:|---:|---:|---|
| 1 | 10,000 | 10,025 | 25 ms | `062135596800000000123997487868` |
| 2 | 20,000 | 20,025 | 25 ms | `062135596800000000222532372501` |
| 3 | 30,000 | 30,025 | 25 ms | `062135596800000000323020744290` |
| 4 | 40,000 | 40,025 | 25 ms | `062135596800000000425462603235` |
| 5 | 50,000 | 50,025 | 25 ms | `062135596800000000525950975024` |
| 6 | 60,000 | 60,025 | 25 ms | `062135596800000000624485859657` |
| 7 | 70,000 | 70,025 | 25 ms | `062135596800000000724974231446` |
| 8 | 80,000 | 80,025 | 25 ms | `062135596800000000819602141767` |
| 9 | 90,000 | 90,025 | 25 ms | `062135596800000000920090513556` |
| 10 | 100,000 | 100,025 | 25 ms | `062135596800000001014284255396` |

These are deterministic local logical-clock observations, not deployed
latencies. The paired AC1 tests prove a stored Queue result still invokes the
kick hook when the G44 path returns `BLOCK` and that concurrent kicks remain
single-flight; the AC2 test proves the kick pass uses only the retained proven
frontier. The G44/G62/G61/G60/G65 existing lanes remain separate and
unchanged.

## Local gates

Passed: `npm run test:g67` (four focused tests, red-before-green receipt,
green receipt, and both mutants red), `npm run typecheck`, `npm run lint`,
`npm run test:g44`, `npm run test:g58`, `npm run test:g60:required`,
`npm run test:g61`, `npm run test:g62`, and `npm run test:g65:required`.
`git diff --check` is clean for the scoped checkpoint.

The first aggregate `npm run check` stopped in the unchanged G28 boundary
lane because npm could not write its log under the seat's root-owned
`~/.npm`. The identical aggregate with
`npm_config_cache=/private/tmp/sdt-g67-npm-cache` passed the boundary setup and
progressed through the repository tests, but its normal parallel Vitest run
reported two existing 5-second timeouts (`test/commit.spec.ts` AC7 and
`test/tag.spec.ts` G5; 767 passed, 1 skipped). Each exact test passed when
isolated with `--maxWorkers=1`. A serial aggregate with
`VITEST_MAX_WORKERS=1` reached the unchanged G32 parity lane and produced no
further output; it was timeboxed and terminated with exit 130. Its complete
log is preserved at `/private/tmp/sdt-g67-w142-check-serial.log` for local
diagnosis and is not a repository artifact. No G67 assertion, timeout, or
gate was changed to obtain these classifications.

## Remaining boundary

This checkpoint intentionally stops before AC4/AC5. It does not deploy to the
reused `sekiban-dcb-g60-w155-c` arm, reset operational data, or use the
production sample. A later continuation must run the same-arm baseline/post
cohorts and then the production cohort with observed clocks and pass triggers.

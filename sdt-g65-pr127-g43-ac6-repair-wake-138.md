# SDT-G65 PR #127 G43 AC6 repair — WAKE-138

## Checkpoint

- PR: `J-Tech-Japan/sekiban-dcb-ts#127`
- Branch: `claude/sdt-g65-local-wake-w128`
- Starting PR head: `ff7bd549484ffb14e7a272ab8b5460a0ba035efe`
- Scope: narrow G43 AC6 product/G65 scheduling repair and guard maintenance only.
- No Wrangler, Cloudflare, deployment, resource, merge, review-state, or host-metadata operation was performed.
- The unrelated dirty and untracked evidence present at start was preserved and was not staged.

## Pinned failure and diagnosis

The authoritative failure was [ci-g43 job
101339016999](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/33978381396/job/101339016999)
in workflow `33978381396`, at `test/g43-tag-sql.spec.ts:443`. The test is
`AC6: a due obligation inserted while delivery runs is retained and re-armed
for the next handler`. The fixture already retained HTTP 201 and consumed
`nestedAppend.arrayBuffer()`; its assertions, timing, timeout, and scheduler
expectation were not changed.

The expected nested obligation was event `0ecb1824-ac84-78df-9698-d91b9abfdcfe`
(`insert-2`). The failing scan instead returned the original pending
obligation `11cb1824-b19d-78df-96b1-de1b9abfdffe` (`insert-1`). The isolated
AC6 test passed, while the full three-file G43 run reproduced the failure
under parallel workerd load, establishing a real scheduling interaction
rather than a changed fixture identity.

The G65 first-write path was still awaiting the asynchronous G44 schema probe
on a binding whose resolved result was “no G44 global-array authority.” In the
unconfigured root composition, that extra boundary could leave the nested
append behind the in-flight alarm’s source scan under parallel load. The
repair now remembers the resolved authority result per D1 binding and returns
the unconfigured disposition synchronously once it is known false. The
unconfigured path performs no registration row write and schedules no
registration watermark. The configured G44 path is unchanged: first-write
registration remains bounded and response-gating, a registration failure is
the typed retryable `503 partition_registration_unavailable`, and existing
registered partitions do not await D1. The durable event/outbox/receipt order,
Queue fallback, G44 fence, V1 body, admission header, and safe-lane behavior
are unchanged.

## Scoped changes

- `packages/dcb-runtime/src/tag/TagDurableObject.ts`: carry the explicit
  registration disposition through the SQL append; omit local source
  registration bookkeeping for an explicitly unconfigured store; add the
  resolved-negative authority fast path. Configured registration semantics
  remain intact.
- `test/g65-admission.spec.ts`: assert the unconfigured first-append path
  leaves no source-registration row.
- `scripts/g43-commit-mutation-runner.mjs`: update only the obligation
  mutation anchor for the added explicit argument.
- `scripts/g65-admission-guard.mjs` and
  `scripts/g60-queue-latency-guard.mjs`: accept the equivalent multiline
  append call while retaining the ordering, omission, old-waitUntil, and
  durability checks. No mutant or gate was removed or weakened.

## Red/green evidence

| Proof | Result |
| --- | --- |
| Pre-change G65 unconfigured first-append test | Red as intended: old path left 1 `tag_source_partition_registration` row; expected 0 |
| Post-change focused G65 test | Green: 1 passed, 13 skipped |
| Full G43 before final fast path | Reproduced the pinned AC6 identity failure under the three-file parallel run |
| Full `npm run test:g43` after repair | Green: 3 files, 20 tests; all five production commit-fact mutants red |
| G60 queue/direct/unsafe-writer guards | Green; old waitUntil, omission, ordering, duplicate, and regression mutants red |
| G65 required guard/mutation suite | Green; existing G65 red receipts retained |

The exact G43 test source and expected event identity remain unchanged.

## Local CI-equivalent verification

Final affected lanes passed:

- `npm run test:g43`, `npm run test:g44`, `npm run test:g60:required`,
  `npm run test:g65:required`
- `npm run test:g26`, `npm run test:g27`, `npm run test:g31`,
  `npm run test:g38:prep`, `npm run test:g42`, `npm run test:g45`,
  `npm run test:g46`, `npm run test:g49`, `npm run test:g53`,
  `npm run test:g55`, `npm run test:g58`, `npm run test:g61`,
  `npm run test:g62`
- G29 mapping, delivery, diagnostics, compatibility, domain-source,
  authoring-doc, sample, witness, and candidate lanes
- G21–G25, G28 compile/boundary/domain lanes, G32 bridge/candidate, and the
  full G32 lane after the cache correction described below
- `npm run test:g51`, G30 candidate, G40 coverage/mutation/needs self-tests,
  `npm run lint`, `npm run typecheck`, and `git diff --check`

Two local-environment corrections were investigated and passed on rerun:

- G28 package-boundary probes initially failed because npm tried to write its
  log under the non-writable global cache. Rerun with
  `NPM_CONFIG_CACHE=/private/tmp/g65-w138-npm-cache` passed source,
  negative-fixture, and package-manifest gates.
- G32 initially reached all JavaScript/SQL/mutation checks but .NET parity
  restore failed on the sandbox's non-writable global NuGet paths. Rerun with
  `NUGET_PACKAGES=/private/tmp/g65-w138-nuget-packages`
  `NUGET_HTTP_CACHE_PATH=/private/tmp/g65-w138-nuget-cache` and the same
  private npm cache passed the full lane, including the pinned parity SHA
  `855feaa93564fef54defec76e9ccff969d4ee01a`.

The aggregate `npm test` was also run unchanged. It reproduced the known
file-wide concurrency condition: `test/commit.spec.ts` AC7 and
`test/tag.spec.ts` G5 timed out at the existing 5,000 ms limit. The two
targeted isolated commands both passed (one test each); no timeout, test
expectation, or gate was changed.

The full G30 command reached its final
`"result":"all-production-config-mutants-red"` receipt, then remained alive
in the known trace-mutation runner. Only that identified completed runner was
terminated (exit 130). The temporary `CommitTraceVerifier` mutation was
restored and `git diff` confirms no trace/G30 product change remains. G51 and
the G30 candidate checks passed. This is an environment/runner exception,
not a G65 or G43 result.

Local non-Wrangler e2e/contract lanes passed: `test:store-contract`,
`test:d1`, `test:mv`, `test:boundaries`, `test:consumer`, `test:g16`,
`test:g20`, G20 gate/candidate, Cosmos wiring, and G40 checks. The workflow's
`npm run build` (`wrangler deploy --dry-run`) and G15/G16 local Worker e2e
were not invoked because this task explicitly forbids Wrangler/Cloudflare
operations. Real Cosmos emulator lanes were not claimed: the required
emulator credentials were absent. These are recorded boundaries, not hidden
failures.

## Preserved boundaries and handoff

- No G43 fixture assertion, timeout, expected event identity, or scheduler
  contract was changed.
- The G65 configured-store carve-out remains exact; no first-write refusal is
  introduced for an unconfigured store.
- No G60 5,000 ms contract, Queue/outbox/global admission behavior, G44
  completeness fence, G58/G62 behavior, V1 wire, or unrelated trace path was
  changed.
- Existing dirty/untracked receipts and evidence were deliberately left
  outside the commit.

The final checkpoint SHA is the pushed commit containing this artifact and is
reported by the canonical worker transition and final report.

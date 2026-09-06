# SDT-G65 PR #127 G43 AC6 repair 2 — WAKE-138

## Checkpoint and scope

- Task: `SDT-G65-PR127-G43-AC6-REPAIR-2-WAKE-138`
- PR: `J-Tech-Japan/sekiban-dcb-ts#127`
- Branch: `claude/sdt-g65-local-wake-w128`
- Pinned source under test: `5efd2b4fadf7a52b8ba183f07924dce51ce50097`
- Scope: product/G65 scheduling repair plus one G65 regression test. No G43
  fixture, scheduler expectation, timeout, direct-doorbell configuration, PR
  state, merge, closeout, Wrangler, Cloudflare, deployment, or resource
  operation was performed.
- The unrelated dirty and untracked files present at start were preserved and
  were not staged.

## Pinned failure and diagnosis

The hosted failure was `ci-g43` job `101368970287` at the pinned head. The
failed assertion was `test/g43-tag-sql.spec.ts:443`, AC6:
“a due obligation inserted while delivery runs is retained and re-armed for
the next handler.” It expected the obligation for event
`0ecb1824-ac84-78df-9698-d91b9abfdcfe`, but the scan retained the original
pending obligation for event `11cb1824-b19d-78df-96b1-de1b9abfdffe`.

The G43 fixture already consumes the nested append response body and retains
HTTP 201. Its assertion, expected identity, scheduler contract, and timeout
were not changed. Isolated AC6, the exact `npm run test:g43` lane, and the
D1-heavy pairwise group all pass after the repair. The diagnostic append trace
also showed both obligations durably present after the nested append. The
failure therefore came from the G65 path adding an unnecessary synchronous
global-admission/D1 boundary in the explicitly unconfigured local composition,
which allowed the in-flight alarm scan to observe the first obligation before
the nested append completed under file-wide Worker load.

## Repair

`TagDurableObject` now carries the source-partition registration disposition
through the SQL append path. When the G44 completeness store resolves as
explicitly unconfigured, the first append does not introduce a synchronous
global-admission probe merely because a non-authoritative local D1 binding is
present; the committed event, outbox obligation, local receipt, and ordinary
Queue fallback remain unchanged. Configured G44 stores retain bounded
admission, and an already registered partition still reports the existing
`not-admitted` header behavior when D1 is unavailable. The safe completeness
fence, Queue ordering/retry path, direct doorbell, V1 body, and G58/G62
behavior are unchanged.

The new G65 test uses a real Tag DO append with an unconfigured D1 probe and a
Queue stub. It proves status 201, no admission header, no migration-binding
probe, and Queue fallback. The existing six G65 guards and production
idempotence mutant remain unchanged.

## Red/green evidence

| Proof | Result |
| --- | --- |
| Hosted pinned AC6 | Red at job `101368970287`; expected nested event `0ecb1824-ac84-78df-9698-d91b9abfdcfe`, observed original `11cb1824-b19d-78df-96b1-de1b9abfdffe` |
| `npm run test:g43` | Green: 3 files, 20 tests; all five production commit-fact mutants red |
| `npm run test:g65:required` | Green: 15/15 tests; six guard mutants red; production idempotence-removal oracle red-before-green then green |
| G43 + D1-heavy pairwise group | Green: 6 files, 58 tests |
| New unconfigured-store regression | Green: no synchronous admission probe and Queue fallback |
| G43 fixture/config diff audit | Clean; neither `test/g43-tag-sql.spec.ts` nor the direct-doorbell config changed |
| `git diff --check` | Green |

The prior G65 red receipt for the unconfigured first-write path remains
preserved in the existing evidence; no guard was weakened to make this repair
green.

## Local CI-equivalent results

Passed lanes include:

- `npm run lint`, `npm run typecheck`, `npm run test:g37:evidence`, G50
  latency guard/check, `npm run test:g52`, `npm run test:g17`, and the rollout
  order fixture.
- G21–G29, G31–G32, G38, G41–G46, G49, G51, G53–G54, G56, G58, G60 required,
  G61, G62, and G65 required lanes, including their expected forced-red and
  mutation probes.
- Local store/D1/MV/consumer/boundary/G16/G20 checks and G40 coverage,
  mutation, and dependency self-tests.
- G28 package-boundary gates passed after rerunning with
  `NPM_CONFIG_CACHE=/private/tmp/g65-w138-npm-cache`; the initial failure was
  only npm's unwritable global log directory. G32 passed with private npm and
  NuGet cache paths.

The unchanged aggregate `npm test` exited 1 with 90 files, 756 passed tests,
2 failed tests, and 1 skipped test. The only failures were the existing
file-wide-pool 5,000 ms timeouts in `test/commit.spec.ts` AC7 and
`test/tag.spec.ts` G5. The pinned G43 AC6 failure did not recur in this run;
no timeout or expectation was changed.

The G30 lane reached its production/configuration mutation receipts, including
the all-production-config-mutants-red result, but its known trace-mutation
runner remained alive without producing a terminal result and was terminated
with exit 130. G51 and the G30 candidate lane passed separately. This is an
environment/runner exception, not a G65 or G43 result.

The workflow's `npm run build`/local Worker E2E steps were not run because
they invoke Wrangler and this task forbids all Wrangler/Cloudflare operations.
The Cosmos emulator job was not started locally; its wiring self-test passed.

## Preserved boundaries and handoff

- No G43 fixture assertion, scheduler expectation, timeout, or expected event
  identity changed.
- The direct-doorbell configuration repair at `ff65602` remains untouched.
- No 5,000 ms contract, Queue/outbox/global admission ownership, G44 fence,
  G58/G62 behavior, V1 wire, or unrelated dirty evidence changed.
- The pushed checkpoint SHA is the commit containing this artifact and is
  reported by the final canonical notification.

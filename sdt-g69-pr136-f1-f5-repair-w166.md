# SDT-G69 PR #136 F1–F5 repair — W166

Status at this checkpoint: the scoped repair is pushed on
`claude/sdt-g69-local-ordering-proof-w164` in source commit
`9838d75` (`fix: harden G69 ordering safety boundaries`). The evidence commit
containing this receipt is the next commit on that branch. No Wrangler,
Cloudflare, deployment, production, retry, drain, SafeWindow, first-arrival
fence, allocator-closure, G32, or cleanup operation was performed.

## F1 — detector clock and generation safety

The detector is now exercised by the real allocator → Tag → D1 → G44/G62
path. `findLateLowerSuidEvidence` distinguishes `late-lower-suid`, `replay`,
`miss`, and `unknown`. Invalid/rolled-back clocks and untrusted imported or
repaired provenance produce an `ORDERING_DETECTOR_UNKNOWN` incident/alarm and
do not cause a guessed safe-read refusal. A proven late lower SUID remains the
only path that opens the generation-scoped ordering quarantine. The test also
proves public safe behavior rather than injecting `SETTLED`; the local alarm
route's Miniflare 404 is retained as an environment-only limitation.

## F2 — generation-consistent public boundary

Safe D1 MV reads check ordering quarantine and active generation at the initial
boundary and again after `waitFor` (and for the no-wait response boundary). A
quarantine created while a read waits therefore returns typed HTTP 503,
`projection_ordering_quarantined`, while unsafe reads remain available for
diagnosis. The read path passes the observed active generation into the MV
read, so an old-generation quarantine cannot be treated as a new-generation
safe result.

## F3 — explicit verified recovery

An empty or incomplete candidate cannot resolve quarantine. Promotion requires
a positive applied-event count, a non-empty checkpoint and a durable rebuilt
row set marked with `rebuild_verified_at`; only then does the atomic promotion
resolve the older generation's quarantine. The local proof shows that rebuilt
rows restore safe reads and that a generation transition remains isolated.

## F4 — first-arrival minimum

Replay upserts restore `FirstArrivedAt = MIN(existing, incoming)` and retain
`LastArrivedAt = MAX(existing, incoming)`. A decreasing-timestamp replay test
proves the minimum is not overwritten. The lag estimate's observed clock is
also monotonic, so a late replay cannot make the retained observation move
backwards.

## F5 — bounded, non-blocking diagnostic receipt

The admission-attempt receipt is diagnostic only. Core `recordDelivery`
returns without awaiting its before-read or receipt write; Queue callers attach
the receipt promise to the invocation `waitUntil` lifetime. The ledger keeps a
nullable actual Queue wrapper ID separate from the envelope `attempt_id`, and
records honest before/after observation consistency plus `stored`, `duplicate`,
collision and `failed` classifications. The newest 512 receipts per service
are retained. Focused coverage includes diagnostic failure, concurrent
delivery, replay, retention and the awaited/omitted-receipt mutants. No
allocation closure is inferred from this ledger.

## Preserved contract and evidence limits

The six existing SDT-G60 mutants are unchanged and remain green under their
red-capable guard. G44/G62 frontier and safe semantics, Queue disposition,
retry and drain behavior, SafeWindow, the first-arrival-fence decision and
production configuration are unchanged. The structural allocator witness is
not a production incident; W166 does not claim AC4/AC5, zero production
detections, or a deployed recovery result. Issue #133 remains referenced and
open rather than closed.

## Local verification

Passing results at source commit `9838d75`:

| Command | Result |
|---|---|
| `npm exec vitest run --config vitest.config.ts test/g69-ordering.spec.ts test/g31-waitfor.spec.ts --maxWorkers=1` | 2 files, 29 tests passed |
| `npm run test:g69` | baseline green; 4 mutants red (detector, lag exclusion, receipt omission, awaited receipt) |
| `npm run test:g31` | 34 tests passed; budget `maxIterationSlots=126`, `maxPointReads=254` |
| `npm run test:g44` | contract/8 tests passed; G44 production mutants red |
| `npm run test:g60:direct` | 14 tests passed; six G60 mutants red |
| `npm run test:g60:unsafe-writer` | 4 tests passed; unsafe-writer guards/mutants red |
| `npm run test:g61` | green guard, pre-fix probe red, mutant probe red |
| `npm run test:g62` | green guard and scheduled-maintenance mutants red |
| `npm run test:g65` | 17 tests passed; guard and six mutants red |
| `npm run test:g67` | 11 tests passed; red-before-green and seven mutants red |
| `npm run test:d1` | 12 tests passed |
| `npm run test:mv` | 18 tests passed |
| `npm run build --workspace @sekiban/dcb-runtime` | passed |
| `npm run build:packages` / `npm run typecheck` | passed in checkout-local dependency context |
| `npm run lint` | passed with `--max-warnings=0` |
| `git diff --check` | passed |

`npm run test:g58` passed its 5 files/15 tests and earlier guards, then
stopped at the pre-existing W96 diagnosis witness:
`same-tick frontier witness remains red (exit null); inspect
.artifacts/sdt-g58-w97-green-guard.json`. This is recorded as a G58
runner/environment exception, not green and not repaired. The separately
known stale-parent isolated-worktree build/typecheck declaration issue is also
an environment exception; no unrelated change was used to mask either one.

Hosted exact-head CI is the remaining rereview gate. Its terminal result is
reported in the canonical handoff for the immutable source/evidence head; this
receipt is not amended after CI merely to change that status.

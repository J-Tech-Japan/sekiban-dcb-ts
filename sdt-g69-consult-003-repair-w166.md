# SDT-G69 consultation-003 repair — W166

Task: `SDT-G69-CONSULT-003-REPAIR-W166`
Issue: #133 (remains open; AC4/AC5 remain outstanding)
PR: #136
Branch: `claude/sdt-g69-local-ordering-proof-w164`
Repair source commit: `211e2e379d515a65260b7bb7ca8e95d9b159aa44`

## Scope and decision

This is a local safety repair only. No Wrangler, Cloudflare, deployment,
production cohort, reset, resource cleanup, first-arrival fence, SafeWindow,
retry, drain, G32, or PR merge/review-state operation was performed.

The selected consultation-003 option is **validated generation-scoped
fail-closed quarantine**. It is chosen because the existing real allocator
witness can put a lower SUID after a safe checkpoint; a diagnostic-only alarm
would leave the public safe reader exposed. The implementation persists and
validates the affected service/view/generation before returning the typed safe
read refusal, while leaving G44/G62 certification and Queue behavior intact.

## AC1 witness qualification

The proof is structural, not a production incident. One allocator request
creates lower and higher candidates. The higher candidate is directly Tag
appended; the lower candidate remains held. Automatic outbox draining is
disabled, the higher arrival is backdated 60 seconds to accelerate the local
SafeWindow, and the real Tag → D1 `recordDelivery` → G44/G62 safe-lane path is
run without an injected `SETTLED` result. The lower candidate is then appended
and delivered.

The observed relation is preserved: G44 first reports its normal
`BLOCK/UNSETTLED` state, the higher event can become safe, and the later lower
arrival produces `LATE_LOWER_SUID`. The detector appends the existing delivery
incident and persists the active-generation quarantine. The local coordinator
alarm route’s `safe_lane_alarm_schedule_failed:404` is an environment-only
Miniflare receipt, not deployed evidence.

The prior engineering recommendation is retained verbatim in
`docs/SDT-G69-evidence.md` as a dissent/history record. The first-arrival fence
is not implemented and no allocation-to-arrival bound is claimed.

## Consultation-003 corrections

### Non-blocking, bounded admission receipt

`recordDelivery` starts its diagnostic before-read concurrently, completes core
admission, and invokes best-effort receipt persistence outside the awaited core
path. The receipt now records before/after observation clocks and an explicit
`observation_consistency` value, so a late read is not presented as allocation
closure. Retention is bounded to the newest 512 rows per service. DeliveryCore,
Queue disposition/retry/DLQ, G44, MV catch-up and public reads do not consume the
ledger.

### Intended lag-estimate safety/latency change

The late-lower lag fix is an intended safety/latency change, not happy-path
neutral. The prior higher-SUID exclusion is removed so a lower-SUID arrival can
raise the decayed estimate even when a higher SUID exists. The deterministic
local measurement records `estimate_ms=2000` and `observed_at=11000`; restoring
the exclusion is a red mutant. No deployed latency effect is claimed.

### Quarantine and recovery

The detector writes `mv_ordering_quarantines` with service, view, generation,
checkpoint SUID, late SUID, event ID, classification and observed time, and
emits structured `SDT-G69_ORDERING_QUARANTINE` log data for alerting. The safe
public D1-MV query checks the active generation and returns HTTP 503 with
`projection_ordering_quarantined`; an explicit unsafe read remains available
for diagnosis. A rebuild/candidate promotion resolves only old-generation
quarantines atomically with the active-generation pointer. No read path clears
the gate. The local proof covers persistence, public refusal, unsafe escape and
generation recovery; deployed alert/recovery evidence remains future work.

The false-positive guard covers equal-millisecond arrival, delayed admission
with an earlier first timestamp, a later checkpoint-clock overwrite, replay
preserving the first-arrival minimum while updating last arrival, clock
rollback, imported/unknown repaired timestamps, and generation transition.

## Local verification

| Command | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run build --workspace packages/dcb-runtime` | PASS |
| `node ../node_modules/vitest/vitest.mjs run --config vitest.g69.config.ts --no-cache --maxWorkers=1 test/g55-read-visibility.spec.ts test/g69-ordering.spec.ts` | PASS, 2 files / 8 tests |
| `node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --no-cache --maxWorkers=1 test/d1-pipeline.spec.ts` | PASS, 12 tests |
| `npm run test:g69` | PASS; four mutants red (exit 1) and restored |
| `git diff --check` | PASS |

The initial hosted exact-head run `34166968931` at `7c2f8832e989d3b47b1b814605cc4198d83d97ca`
exposed two compatibility assertions caused by the newly intentional
quarantine surface: `ci-foundation` and `ci-local-e2e` both reached the G19
ORDER_VIOLATION case in `test/d1-mv.spec.ts`, whose old assertion expected the
pre-quarantine message, while `ci-g31` expected 27/127 MV statements and the
new indexed active-generation quarantine read made those 28/128. The repair
updates the G19 assertion to require `MV_ORDERING_QUARANTINED` and an ordering
violation message, and counts the additional read without changing any wait
bound, retry, frontier or public safe-read rule. The focused rerun of
`test/d1-mv.spec.ts` plus `test/g31-waitfor.spec.ts` is 37/37 green. The
follow-up hosted exact-head result is the final CI authority; no deployment or
production evidence is implied by this correction.

The direct D1 test under `vitest.g69.config.ts` was not used as a result because
that intentionally narrow source-alias config does not alias the unrelated
`@sekiban/dcb-runtime/cosmos` helper; the canonical repository config passed
the same 12-test D1 file. This is a configuration-only local exception.

The affected workspace lanes were each run directly:

| Command | Result |
| --- | --- |
| `npm run test:g26` | BLOCKED at `build:packages` |
| `npm run test:g27` | BLOCKED at `build:packages` |
| `npm run test:g41` | BLOCKED at `build:packages` |
| `npm run test:g43` | BLOCKED at `build:packages` |
| `npm run test:g44` | BLOCKED at `build:packages` |
| `npm run test:g58` | BLOCKED at `build:packages` |
| `npm run test:g60:required` | BLOCKED at first `build:packages` sublane |
| `npm run test:g61` | BLOCKED at `build:packages` |
| `npm run test:g62` | BLOCKED at `build:packages` |
| `npm run test:g65:required` | BLOCKED at `build:packages` |
| `npm run test:g67` | BLOCKED at `build:packages` |
| `npm run typecheck` | BLOCKED at `build:packages` |
| `npm run test:d1` | BLOCKED before its test by `build:packages` |

Every blocked workspace lane reported the same pre-existing stale-parent
resolution surface, including `@sekiban/dcb-client` missing
`SnapshotReader.head`, meeting-room missing already-landed G60/G65/G67
exports/options, and missing `ExecuteCommandResult`. These are environment
exceptions, not green results and not caused by this G69 diff; no unrelated
package or sample file was changed to mask them. Hosted exact-head CI is the
required final authority before rereview.

## Boundary and lifecycle

The six SDT-G60 mutants remain unmodified. Issue #133 is referenced, not
closed. AC4/AC5 remain outstanding. The exact pushed repair head and hosted
CI result are reported separately after the evidence commit; no deployment or
production claim is made here.

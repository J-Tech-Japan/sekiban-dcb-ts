# SDT-G58 AC4 lag-hygiene checkpoint (W98)

Status: completed (local/code checkpoint)

This bounded continuation started from
`2db0ad3ff2072959c750d5f71bcd0ff57d1d7fad` on
`claude/sdt-g58-safe-lane-w93`. It did not deploy, invoke Wrangler, mutate
remote D1, send an application request, rerun or stitch the W95 cohort, open a
PR, or complete the worker. SDT-G56 was not touched.

## AC4 lag-decay proof

W95 already observed the decayed estimate falling from about 10 seconds to
`0 ms` while `safeWindowMs` stayed at `20,000 ms`. No single-arrival cap was
added: that evidence does not support one. The implementation remains
`Math.max(0, estimateMs - elapsed)` with the published constants unchanged
byte-for-byte: `PUBLISHED_SAFE_WINDOW_MS = 20_000` and
`MAX_PUBLISHED_SAFE_WINDOW_MS = 120_000`.

`test/g58-safe-lane.spec.ts` now covers both the pure
`decayedLagEstimateMs` helper and the D1-backed `D1EventStore.currentLagBound`
calculation. With an `80,000 ms` estimate, the test observes `80,000 ms` at
the observation timestamp, `1 ms` after `79,999 ms` idle (which still clamps to
the `20,000 ms` floor), and `0 ms` at the one-interval `80,000 ms` boundary.
The resulting service SafeWindow is exactly `20,000 ms`; no stale estimate is
treated as current.

## Red-capable mutation evidence

`scripts/g58-lag-hygiene-guard.mjs` runs the focused oracle green, mutates only
the linear decay expression to a no-decay implementation, requires that oracle
to fail, and restores the source. The complete red output is committed in
`.artifacts/sdt-g58-w98-lag-red-guard.json`:

```json
{"schema":"sdt-g58-ac4-lag-hygiene/v1","status":"red-mutant","baseline":{"exitCode":0},"mutant":{"exitCode":1},"restored":true}
```

The mutant fails on the expected stale value (`1` ms versus received
`80,000` ms), proving the guard is meaningful. The existing W96 red receipt,
W97 green witness, G58 production omission guard, and unchanged G44 guard are
preserved.

## Prepared C-0 purge (not executed)

The next authorized deployment continuation must inventory the lag rows and,
under C-0/C-13, run this exact normal-config remote operation once:

```sh
./node_modules/.bin/wrangler d1 execute D1 --remote --json --yes \
  --config samples/meeting-room/wrangler.cloudflare-only.jsonc \
  --command "DELETE FROM serialized_dcb_lag_estimates WHERE service_id <> 'sekiban-dcb-meeting-room-cloudflare-only'"
```

The same SQL is checked in at
`scripts/deploy/g58-ac4-retired-lag-purge.sql`. Its predicate removes only
retired-service lag-estimate rows and retains the deployed service row
`sekiban-dcb-meeting-room-cloudflare-only`. W98 did not execute the command or
any remote inventory; this is a durable plan for the next wake.

## Validation

- Focused decay oracle (`build:packages` plus pinned Vitest test-name run): **passed**.
- `node scripts/g58-lag-hygiene-guard.mjs --self-test && node scripts/g58-lag-hygiene-guard.mjs`: **passed**; no-decay mutant exit `1`, source restored.
- `npm run test:g58`: **passed** (2 files, 5 tests; existing G58 red-capable and W97 same-tick guards passed).
- `npm run test:g44`: **passed unchanged** (8 tests; all four G44 production mutants red).
- `npm run typecheck`: **passed**.
- `npm run lint`: **passed** with `--max-warnings=0`.

Changed paths are limited to the lag fixture/guard, G58 static/package wiring,
the unexecuted purge plan, this evidence update, the W98 report, and the raw
red-mutant artifact. No SafeWindow bound, G44 correctness test, product
semantics, remote state, or cohort evidence was changed.

Pushed checkpoint: `PENDING_COMMIT_SHA`.

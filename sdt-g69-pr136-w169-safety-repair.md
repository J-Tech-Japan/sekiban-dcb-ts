# SDT-G69 PR136 W169 safety repair

Status: local repair complete; exact-head CI is pending after the scoped push.

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: #136; issue #133 remains open and referenced, not closed
- Starting PR head: `192fd3eedec612af2e7956ed60be5f5cafbdab5a`
- Scope: restore the pre-existing unconditional source-batch order guard and
  restore the PR-base lag-estimator clock semantics. No deployment, Wrangler,
  Cloudflare/resource, fence, SafeWindow, retry, drain, G67 assertion or
  timeout change.

## Repairs

1. `MaterializedViewCatchUpRuntime` now runs the pre-apply SUID batch-order walk
   unconditionally on every default/runtime path. It records the existing
   `ORDER_VIOLATION` incident and generation quarantine before applying rows.
   The new `runOrderingDetector` option gates only the additional late-lower D1
   query, which remains proof-only and off on Queue/delivery, fence-expiry,
   coverage-retry and cron production paths.
2. The G69 guard adds an
   `omit-unconditional-batch-order-guard` mutant against the unchanged default
   G19 regression. The mutant is red; the default test remains unmodified in
   the final PR range and still expects fail-closed rejection with zero rows.
3. `D1EventStore` restores the PR-base
   `observed_at = excluded.observed_at` estimator update. The existing
   higher-SUID exclusion also matches PR base. `test/read.spec.ts` is unchanged
   and retains the public high-lag HTTP 500 behavior.

The qualified structural AC1 allocator-to-Tag-to-D1-to-G44/G62 witness and the
bounded append-only admission-attempt receipt remain. The receipt is strictly
off the awaited delivery path and diagnostic-only. The late-lower query is
proof-only opt-in; it is not claimed as deployed safe-lane protection, free,
or allocator closure. AC4/AC5 remain outstanding.

## Local gates

- `npx vitest run --config vitest.config.ts test/d1-mv.spec.ts`: 14/14 passed;
  default configuration exercised.
- `npm run test:g69`: passed; five mutants red, including unconditional batch
  order, late-lower detector, higher-SUID lag exclusion, append-only receipt,
  and awaited diagnostic receipt.
- `npm run test:g44`: contract and 8 tests passed; all 4 production mutants
  red.
- `npm run test:g46`: 4 files/31 tests passed; all 9 production mutants red.
  The unchanged `test/read.spec.ts` retained the expected HTTP 500.
- `npm run test:g67`: 11/11 behavior tests passed and all 7 mutation probes
  red; the 5,000 ms assertion and timeout were unchanged.
- SQLite alarm/teardown diagnostics appeared during G46/G67 local runs, but
  their test phases exited successfully and no assertion was weakened.

## Retained historical CI receipts

- G46 public fail-closed regression:
  [job 101940978295](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978295).
- G44 unchanged G67 5,000 ms timeout:
  [job 101940978323](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978323).

No deployment or production operation was performed. The exact-head hosted CI
run and terminal C-14 classification will be appended after push without
changing the scoped source repair.

# SDT-G69 PR136 W169 safety repair

Status: local repair complete; hosted exact-head CI is classified as blocked by
known G43/G67 exceptions and still-running G30/G32 runner steps, not by the
W169 source surface.

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

## Exact-head hosted CI classification

- Run `34203242073` for source head
  `1c974fee541932f00d2ceaf1cc7e870d8eb6edcb` was not terminal at this
  checkpoint.
- `ci-foundation` job `101986685395` failed at the known G43 AC6 obligation
  selection assertion in `test/g43-tag-sql.spec.ts:443`: it expected event
  `0ecb1824-ac84-78df-9698-d91b9abfdcfe` but observed the earlier pending
  obligation `11cb1824-b19d-78df-96b1-de1b9abfdffe`. This is the documented
  G43 scheduler/fixture exception and is outside W169.
- `ci-g44` job `101986686018` failed the unchanged G67 AC3 test at
  `test/g67-safe-lane.spec.ts:731` with `Error: Test timed out in 5000ms`
  after 10 passed tests. The G67 assertion and timeout were not changed by
  W169; this is the documented G44 exception.
- `ci-g30-core` job `101986685756` remains in progress in
  `Run SDT-G30 trace schema, B0 cohort, and manifest closure lane`, and
  `ci-g30-forced-red` job `101986685780` remains in progress in
  `Prove SDT-G30 forced-red CI reachability`. Both have no completed log blob
  and match the known G30 hosted runner stall.
- `ci-g32-parity` job `101986685494` remains in progress in
  `Prove SDT-G32 forced-red CI reachability`; its preceding parity lane
  completed successfully. No W169 file is in that lane's scope.
- Green terminal lanes at inspection: G26/G27, G21-G25, G28, G29, G31, G38,
  G41, G42, G43, G45, G46, local-e2e, coverage, and cosmos-emulator.

The hosted failures and stalls are recorded as C-14 exceptions; no gate,
assertion, timeout, or test was weakened. Exact-head rereview remains blocked
until orchestration can classify or rerun those external exceptions.

No deployment or production operation was performed. The source repair is
ready for rereview once the external CI exceptions are resolved.

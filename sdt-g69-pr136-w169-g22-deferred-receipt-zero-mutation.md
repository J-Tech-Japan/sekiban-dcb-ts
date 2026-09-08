# SDT-G69 PR136 W169 G22 deferred-receipt zero-mutation

- Task: `SDT-G69-PR136-W169-G22-DEFERRED-RECEIPT-ZERO-MUTATION`
- PR: `J-Tech-Japan/sekiban-dcb-ts#136`
- Reviewed source head: `aa886d9ae654d1f4f2e3d1bf448958cc5c02975e`
- Scope: local G22 deferred-receipt repair only; no Wrangler, Cloudflare,
  deployment, resource, fixture, timeout, review-state, merge, or production
  operation.

## Finding and repair

The rereview finding was real but narrower than the original G22 assertion.
The stored canonical-identity preflight rejected the conflicting event before
the `recordDelivery` core batch, so the canonical event tables were unchanged.
However, `recordDelivery` still scheduled its deferred G69 diagnostic lifetime;
that lifetime could issue the diagnostic-table `INSERT` and bounded-retention
`DELETE`. The old guard therefore proved zero core batch mutation, not zero D1
mutation for the invocation.

`D1IdentityConflictError` now carries a `beforeMutation` marker only for the
stored pre-admission canonical-identity rejection. That path schedules no
G69 diagnostic promise at all. The diagnostic receipt remains bounded,
best-effort and outside the awaited core admission path for other eligible
outcomes; no diagnostic pre-read was restored and no receipt work is awaited
by delivery.

The G22 production-style regression now:

1. drains the initial diagnostic lifetime before taking its baseline;
2. captures the rejected invocation's `waitUntil` promises;
3. snapshots the canonical tables and
   `serialized_dcb_g69_admission_attempts`; and
4. asserts the typed canonical rejection, zero `recordDelivery` batch starts,
   zero deferred diagnostic promises, and byte-for-byte-equivalent table
   snapshots afterward.

The new red-capable mutant,
`schedule-diagnostic-after-canonical-rejection`, changes the suppression branch
back to scheduling diagnostic work and fails the G22 oracle. This is the
whole-lifetime zero-mutation proof, not only the pre-existing zero-core-batch
proof.

The repair preserves the W169 unconditional default-path pre-apply
`ORDER_VIOLATION` incident/quarantine guard, base D1 lag-estimator semantics,
and the unmodified public high-lag HTTP 500 test. The six SDT-G60 mutants are
unchanged. Fence/SafeWindow, retries, drain behavior, G67 assertions and
timeouts, deployment resources, production resources and G32 resources are
unchanged.

## Local verification

All commands below ran from the W169 worktree after the source/test/guard
repair. Known SQLite alarm/identity teardown diagnostics are recorded as
environment output where noted; no focused command was changed to hide them.

| command | result |
| --- | --- |
| `npm exec vitest run --config vitest.config.ts test/g22-bootstrap-d1.spec.ts --no-file-parallelism --maxWorkers=1` | pass, 1 file / 2 tests |
| `node scripts/g69-ordering-guard.mjs --self-test && node scripts/g69-ordering-guard.mjs` | pass; all 7 G69 mutants exit red, including `schedule-diagnostic-after-canonical-rejection` |
| `npm exec vitest run --config vitest.g69.config.ts test/g69-ordering.spec.ts --no-file-parallelism --maxWorkers=1` | pass, 1 file / 8 tests; known NOSENTRY SQLite alarm teardown messages only |
| `npm exec vitest run --config vitest.config.ts test/g67-safe-lane.spec.ts --no-file-parallelism --maxWorkers=1` | pass, 1 file / 11 tests; known NOSENTRY alarm messages only |
| `npm exec vitest run --config vitest.config.ts test/read.spec.ts --no-file-parallelism --maxWorkers=1` | pass, 1 file / 7 tests; known post-pass DO identity/`EnvironmentTeardownError` output, exit 0; high-lag HTTP 500 assertion unchanged |
| `npm run test:g22` | pass, 2 files / 7 tests |
| `npm run test:g46` | pass, 4 files / 31 tests; all 9 G46 mutation probes red; same known post-pass identity/teardown output |
| `npm run typecheck` | pass |
| `npm run lint` | pass |

The prior exact reviewed head had terminal 20/20 success in hosted run
`34214834449`; this repair is to be validated by the exact-head hosted run
after the scoped push. The final report will record that run's terminal result
and exact source/evidence heads.

## Boundary statement

This checkpoint does not claim AC4/AC5, allocator closure, a deployed detector,
or a change to safe-lane protection. The diagnostic receipt remains
diagnostic-only. A canonical pre-admission identity rejection now has no
deferred diagnostic D1 mutation, while authorized post-admission outcomes keep
their bounded off-path observation semantics.

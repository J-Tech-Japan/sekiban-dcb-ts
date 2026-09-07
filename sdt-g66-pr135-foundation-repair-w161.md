# SDT-G66-PR135-FOUNDATION-REPAIR-W161

## Classification

At PR head `ae6e9784790b869f0081cd3bda60cf64f080335f`, workflow
`34119927294` failed only in `ci-foundation` job `101735406956`:

<https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34119927294/job/101735406956>

The job reached the full `npm test` step. Its terminal Vitest summary was:

```text
Test Files  3 failed | 90 passed | 1 skipped (94)
Tests       5 failed | 775 passed | 1 skipped (781)
```

The five failures were timeouts in existing non-G66 tests:

| Test | Signature |
| --- | --- |
| `test/g43-tag-sql.spec.ts:485` | G43 AC6 backlog/re-arm case, timed out at the unchanged 5,000 ms limit. |
| `test/g67-safe-lane.spec.ts:725` | G67 AC3 ten paced commits with cron disabled, timed out at the unchanged 5,000 ms limit. |
| `test/repair.spec.ts:410` | G6 repair vertical slice re-query case, timed out at 15,000 ms. |
| `test/repair.spec.ts:434` | G6 bounded scan checkpoint case, timed out at 5,000 ms. |
| `test/repair.spec.ts:481` | G6 Branch B/provider-internal exclusion case, timed out at 5,000 ms. |

No G66 test failed: the same log records `test/g66-e2e.spec.ts` as 3 passed
tests. The preceding typecheck and G66-specific checks were successful, and
the same workflow's `ci-g30-core`, `ci-g43`, `ci-g32-parity`, and all other
split lanes completed successfully. The downstream `verify` failure reports
the foundation dependency and is not an additional G66 assertion.

## C-14 unchanged-range proof

The range is based at `origin/main` / merge base
`774f76def8fcf37edf4bd651187bd3a9230efa61`. The failed test paths
`test/g43-tag-sql.spec.ts`, `test/g67-safe-lane.spec.ts`, and
`test/repair.spec.ts` are not changed by the G66 range. The G66 changes are
limited to the G66 harness/guard/test, its package scripts, configuration and
evidence/docs; the earlier type-only repair was already verified by passing
typecheck and G66 tests. No G66 production path, test assertion, timeout,
scheduler, or CI command can explain these named failures from the exact diff.

This is classified as the documented pre-existing full-suite parallel-runner
timeout exception. Prior `docs/SDT-G67-evidence.md` records the same aggregate
pool behavior: the isolated G67 guard passes while unrelated existing tests
time out in the full parallel pool, without changing a timeout or gate. The
earlier `docs/SDT-G65-evidence.md` also records unrelated aggregate failures
of the same class. The known G43 AC6 race/timeout remains an exception only;
no fixture or expectation was changed.

## Action and boundaries

No source repair is warranted. No test, timeout, deployment, Wrangler,
Cloudflare, cleanup, or resource operation was performed for this finding.
The exact CI failure and unchanged-range proof are recorded for C-14; the
G66 evidence and prior typecheck repair remain intact.

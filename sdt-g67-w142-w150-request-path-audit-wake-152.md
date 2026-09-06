# SDT-G67-W142-W150-REQUEST-PATH-AUDIT-WAKE-152

Date: 2026-09-06
Range: `8e8f13d9cb14d547193dc642d9038e5b80d7444a..766f5d328a6615582338ce52965f5017702182eb`
PR: #132, `claude/sdt-g67-local-wake-w142`

## Result

The range contains **no change that executes in the public serialized commit
request from receipt to response**. The request-path gate is satisfied. The
later changes are Queue-consumer, scheduled/alarm safe-lane, safe materialized
view/catch-up, schema, guard/test, documentation, or retained-evidence work.
No W155-C deployment or short parent baseline is required by this audit, and
none was performed.

The exact W142 response comparison remains valid amended-AC4 response evidence
for the unchanged request path:

| arm | source | n | response p50 | response p95 |
|---|---|---:|---:|---:|
| W142 parent | `868f2fc63bb02fb2c127e750c1d22516cc0fcff6` | 10 | 2,606 ms | 2,866 ms |
| W142 candidate | `8e8f13d9cb14d547193dc642d9038e5b80d7444a` | 10 | 2,585 ms | 3,072 ms |

The candidate p50 delta is `-21 ms`. The candidate p95 delta is `+206 ms`,
and the p95 percentage is `+7.19%`: `(3072 - 2866) / 2866 = 0.07187`.
This is within the amended 10% response comparison. All ten W142 samples in
each arm were safe within 180 seconds. The W142 absolute 60-second safe-p95
and +150 ms p95 rules are superseded; the W142 candidate's historical
`kick requested; winner not persisted` trigger limitation is not relabeled
as current attribution. W150 remains authoritative for the current
per-event fence/applying-pass and deployed-configuration evidence.

## Audit method and commands

The audit used the following read-only Git inspections:

```text
git log --format='%H %s' --reverse 8e8f13d9cb14d547193dc642d9038e5b80d7444a..766f5d328a6615582338ce52965f5017702182eb
git diff --name-status --find-renames 8e8f13d9cb14d547193dc642d9038e5b80d7444a..766f5d328a6615582338ce52965f5017702182eb
git diff --unified=0 8e8f13d9cb14d547193dc642d9038e5b80d7444a..766f5d328a6615582338ce52965f5017702182eb -- <runtime paths>
```

The range has 17 commits and 198 changed paths (the large insert count is
retained raw receipts). The public commit boundary was checked in
`packages/dcb-runtime/src/cloudflare.ts` around the
`/api/sekiban/serialized/commit` dispatch and in the sample's
`runtimeFetch`/commit route; neither is changed in this range.

## Commit-by-commit classification

| commit | changed surface | request-path classification |
|---|---|---|
| `540aab1` | W142 arm receipts and deployed-evidence document | no: evidence only |
| `6d69127` | first event-driven pass ledger, Queue kick hook, schema, guards/tests/docs | no: Queue/safe-lane after durable delivery; no commit dispatch change |
| `327eacb` | pass ownership and Queue safe-lane catch-up attribution plus receipts | no: Queue/safe-lane after durable delivery |
| `246c4f2` | W142 local repair checkpoint text | no: evidence only |
| `1e110d9` | event-drive rerehearsal receipts/document | no: evidence only |
| `c4f4d94` | catch-up observation migration and event-level safe apply instrumentation | no: scheduled/Queue MV catch-up, not commit |
| `6b45621` | safe-advancement checkpoint text | no: evidence only |
| `91c36df` | amended AC4 reconciliation receipt | no: evidence only |
| `d596192` | fence-expiry alarm, retry/coalescing and catch-up boundaries | no: Durable Object alarm/scheduled/Queue safe lane, not commit |
| `6467be1` | W145 arm proof receipt | no: evidence only |
| `a83f7c2` | W146 production proof receipts/document | no: evidence only |
| `61c9567` | cleanup receipts and amended-acceptance document | no: evidence only |
| `b4ccd72` | safe-lane attribution and cron through the shared scheduler | no: scheduled/Queue safe lane, not commit |
| `b09ea3f` | W149 review receipt | no: evidence only |
| `47e496d` | fresh coverage for coalesced safe-lane passes | no: Queue/cron scheduler, not commit |
| `766f5d3` | W150 F1/F2 evidence receipt | no: evidence only |

## Runtime path inspection

These are the only changed production runtime files in the range:

| path | changed symbols/surface | can execute before public commit response? |
|---|---|---|
| `packages/dcb-runtime/src/cloudflare.ts` | Queue handler callback shape and scheduled handler `ctx`/safe-lane hook | **No**. The commit dispatch is unchanged; changes are in `queue` and `scheduled`. |
| `packages/dcb-runtime/src/downstream/DownstreamAdapter.ts` | `handleDownstreamQueue` post-`recordDelivery` notification | **No**. This is entered by Queue delivery after the durable record phase, never by CommitWorker. |
| `packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts` | deferred-event/deadline/stop metadata from MV catch-up | **No**. Only safe-lane MV catch-up consumes it. |
| `samples/meeting-room/src/d1-mv.ts` | safe-pass ledger writes/reads, pass observations, health read data, catch-up event boundaries | **No** for commit. The ledger is written by Queue/scheduled/alarm passes; health reads are separate read requests. |
| `samples/meeting-room/src/safe-lane-kick.ts` | single-flight/coalescing scheduler request state | **No**. It is invoked from Queue/scheduled/alarm triggers, not the commit route. |
| `samples/meeting-room/src/worker.cloudflare-only.ts` | Bootstrap alarm, Queue kick registration, cron scheduler, safe-pass runner and health wiring | **No**. The changed paths are Queue/scheduled/alarm; the public commit route and its response construction are unchanged. |

The presence of `waitUntil` in these changes does not put them in the commit
request: the relevant `ctx` is the Queue/scheduled/DO execution context, and
the Queue callback is explicitly notification-only. No changed function is
called by the public CommitWorker before it returns.

## Non-runtime classification

### Schema, guard, and test changes — all not executable in a commit request

- `migrations/d1/g32/0011_g67_safe_lane_passes.sql`
- `migrations/d1/g32/0012_g67_safe_lane_pass_ownership.sql`
- `migrations/d1/g32/0013_g67_safe_lane_catch_up_observations.sql`
- `migrations/d1/g32/0014_g67_safe_lane_fence_expiry.sql`
- `scripts/g49-binding-parity-check.mjs`
- `scripts/g58-block-live-green-guard.mjs`
- `scripts/g58-live-poll-diagnosis-guard.mjs`
- `scripts/g58-reservation-safe-starvation-guard.mjs`
- `scripts/g58-safe-live-starvation-guard.mjs`
- `scripts/g67-safe-lane-guard.mjs`
- `test/d1-pipeline.spec.ts`
- `test/fixtures/g67-green.json`
- `test/fixtures/g67-mutants-red.json`
- `test/fixtures/g67-red-before-green.json`
- `test/g31-sample.spec.ts`
- `test/g67-safe-lane.spec.ts`
- `test/helpers/g44-d1-migration.ts`

These files either add the safe-pass observer schema, test/mutation coverage,
or static guard checks. They are not production request code.

### Documentation changes — all not executable in a commit request

- `docs/SDT-G67-evidence.md`
- `docs/safe-lane.md`

### Retained evidence and raw receipts — all not executable in a commit request

- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-cohort.json`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-cohort.log`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-deploy.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-deployments.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-migrations-after.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-migrations-apply.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-migrations-before.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-mv-clean-counts.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-pipeline-clean-counts.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-post-counts.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-queue-consumer.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-reset-mv.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-reset-pipeline.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-safe-history-command.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-safe-history.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-safe-passes-command.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-safe-passes-retry-1.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-safe-passes.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-version-view.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-history-query.sql`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-cohort.json`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-cohort.log`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-deploy.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-deployments.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-history-query.sql`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-mv-clean-counts.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-pass-query.sql`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-pipeline-clean-counts.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-reset-mv.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-reset-pipeline.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-safe-history-corrected.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-safe-history.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-safe-passes-corrected.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-safe-passes.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-parent-version-view.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-pass-query.sql`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-queue-consumer.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-reset-pipeline.sql`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-whoami.txt`
- `.artifacts/sdt-g67-ac4-event-drive-rerehearsal-wrangler-version.txt`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-cleanup-worker-w131-c.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-migrations-apply.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-preflight-mv-migrations.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-preflight-pipeline-migrations.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-preflight-queues.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-preflight-versions.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-admission-ledger.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-cohort-valid.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-cohort.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-deploy.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-deployments-final.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-deployments.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-hop-ledger.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-hop-submeasurements.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-lag-estimates.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-redeploy-after-secret.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-reset.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-ring-ledger.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-safe-history.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-safe-pass-ledger-final.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-safe-pass-ledger.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-version-view-final.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-version-view.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-secret-list.json`
- `.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-secret-put.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-d1-resolution.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-d1-mv.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-d1-pipeline.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-queue-dlq.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-queue-outbox.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-worker.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-detach-outbox-consumer.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-final-d1-inventory.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-final-production-worker-inventory.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-final-queue-inventory.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-queue-after-detach.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-queue-resolution.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-worker-after-delete.json`
- `.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-worker-resolution.json`
- `.artifacts/sdt-g67-w142-arm-candidate-admission.json`
- `.artifacts/sdt-g67-w142-arm-candidate-cohort.json`
- `.artifacts/sdt-g67-w142-arm-candidate-cohort.log`
- `.artifacts/sdt-g67-w142-arm-candidate-deploy.log`
- `.artifacts/sdt-g67-w142-arm-candidate-deployments.json`
- `.artifacts/sdt-g67-w142-arm-candidate-events.json`
- `.artifacts/sdt-g67-w142-arm-candidate-global-receipts.json`
- `.artifacts/sdt-g67-w142-arm-candidate-hops.json`
- `.artifacts/sdt-g67-w142-arm-candidate-ledger-read-status.txt`
- `.artifacts/sdt-g67-w142-arm-candidate-mv-rows-mv.json`
- `.artifacts/sdt-g67-w142-arm-candidate-mv-rows.json`
- `.artifacts/sdt-g67-w142-arm-candidate-mv-unsafe-receipts-mv.json`
- `.artifacts/sdt-g67-w142-arm-candidate-mv-unsafe-receipts.json`
- `.artifacts/sdt-g67-w142-arm-candidate-mv-unsafe-rows-mv.json`
- `.artifacts/sdt-g67-w142-arm-candidate-mv-unsafe-rows.json`
- `.artifacts/sdt-g67-w142-arm-candidate-reset-mv-counts.json`
- `.artifacts/sdt-g67-w142-arm-candidate-reset-mv.json`
- `.artifacts/sdt-g67-w142-arm-candidate-reset-pipeline-counts.json`
- `.artifacts/sdt-g67-w142-arm-candidate-reset-pipeline.json`
- `.artifacts/sdt-g67-w142-arm-candidate-rings.json`
- `.artifacts/sdt-g67-w142-arm-candidate-safe-health.json`
- `.artifacts/sdt-g67-w142-arm-candidate-safe-history.json`
- `.artifacts/sdt-g67-w142-arm-candidate-subhops.json`
- `.artifacts/sdt-g67-w142-arm-candidate-unsafe-writers.json`
- `.artifacts/sdt-g67-w142-arm-candidate-version-view.json`
- `.artifacts/sdt-g67-w142-arm-parent-admission.json`
- `.artifacts/sdt-g67-w142-arm-parent-cohort.json`
- `.artifacts/sdt-g67-w142-arm-parent-cohort.log`
- `.artifacts/sdt-g67-w142-arm-parent-events.json`
- `.artifacts/sdt-g67-w142-arm-parent-global-receipts.json`
- `.artifacts/sdt-g67-w142-arm-parent-hops.json`
- `.artifacts/sdt-g67-w142-arm-parent-ledger-read-status.txt`
- `.artifacts/sdt-g67-w142-arm-parent-ledger.json`
- `.artifacts/sdt-g67-w142-arm-parent-mv-ledger.json`
- `.artifacts/sdt-g67-w142-arm-parent-mv-rows.json`
- `.artifacts/sdt-g67-w142-arm-parent-mv-unsafe-receipts.json`
- `.artifacts/sdt-g67-w142-arm-parent-mv-unsafe-rows.json`
- `.artifacts/sdt-g67-w142-arm-parent-rings.json`
- `.artifacts/sdt-g67-w142-arm-parent-safe-history.json`
- `.artifacts/sdt-g67-w142-arm-parent-subhops.json`
- `.artifacts/sdt-g67-w142-arm-parent-unsafe-writers.json`
- `.artifacts/sdt-g67-w142-arm-reset-mv-attempt-1.json`
- `.artifacts/sdt-g67-w142-arm-reset-mv-counts-corrected.json`
- `.artifacts/sdt-g67-w142-arm-reset-mv-counts.json`
- `.artifacts/sdt-g67-w142-arm-reset-pipeline-attempt-1.json`
- `.artifacts/sdt-g67-w142-arm-reset-pipeline-counts-corrected.json`
- `.artifacts/sdt-g67-w142-arm-reset-pipeline-counts.json`
- `.artifacts/sdt-g67-w142-parent-868f2fc-deploy.log`
- `.artifacts/sdt-g67-w142-parent-868f2fc-deployments.json`
- `.artifacts/sdt-g67-w142-parent-868f2fc-version-view.json`
- `.artifacts/sdt-g67-w142-parent-deploy-retry.log`
- `.artifacts/sdt-g67-w142-parent-deploy.log`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-cohort.json`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-cohort.log`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-d1-migrations.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-deploy.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-deployments.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-migration-0011.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-queue-consumer.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-reset-mv.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-reset-passes.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-reset-pipeline.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-safe-health.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-safe-history.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-safe-passes.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-candidate-version-view.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-cohort.json`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-cohort.log`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-d1-migrations.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-deploy.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-deployments.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-queue-consumer.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-reset-mv.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-reset-pass-ledger.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-reset-pipeline.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-parent-version-view.txt`
- `.artifacts/sdt-g67-w142-rerehearsal-whoami.txt`
- `.artifacts/sdt-g67-w142-reset-pipeline.sql`
- `.artifacts/sekiban-dcb-g67-amended-ac4-production-cleanup-wake-146-post-cohort-d1-resolution.json`
- `.artifacts/sekiban-dcb-g67-amended-ac4-production-cleanup-wake-146-post-cohort-queue-resolution.json`
- `.artifacts/sekiban-dcb-g67-amended-ac4-production-cleanup-wake-146-post-cohort-worker-resolution.json`
- `sdt-g67-ac4-event-drive-repair-wake-142.md`
- `sdt-g67-ac4-event-drive-rerehearsal-wake-142.md`
- `sdt-g67-ac4-repair-wake-142.md`
- `sdt-g67-ac4-rerehearsal-wake-142.md`
- `sdt-g67-ac4-safe-advancement-repair-wake-142.md`
- `sdt-g67-amended-ac4-production-cleanup-wake-146.md`
- `sdt-g67-amended-ac4-reconcile-wake-143.md`
- `sdt-g67-amended-acceptance-cleanup-pr-wake-147.md`
- `sdt-g67-deployed-wake-142.md`
- `sdt-g67-fence-expiry-arm-wake-145.md`
- `sdt-g67-fence-expiry-local-wake-144.md`
- `sdt-g67-pr132-f1-f2-repair-wake-150.md`
- `sdt-g67-pr132-review-repair-local-wake-149.md`

## Boundary and action

No request-path change was found. The audit gate is satisfied, the W142
parent/candidate response evidence is valid for the unchanged request path,
and no deployment or new baseline is authorized/needed by this task. No
Wrangler, Cloudflare, production, W155-C, PR review, merge, or resource
operation was performed. The only intended changes for this task are the
evidence audit and its linked docs/PR wording.

## Validation

- `git diff --check -- docs/SDT-G67-evidence.md sdt-g67-w142-w150-request-path-audit-wake-152.md` — passed.
- The read-only range check
  `git diff --check 8e8f13d9cb14d547193dc642d9038e5b80d7444a..766f5d328a6615582338ce52965f5017702182eb`
  reports pre-existing trailing whitespace/newline findings in retained raw
  deployment receipts and historical W142/W145/W146 evidence documents. It
  does not report the W152 scoped files; those findings were not rewritten or
  weakened.
- No Wrangler, Cloudflare, deployment, resource, or cohort command was run.

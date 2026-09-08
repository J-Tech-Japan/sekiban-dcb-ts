# SDT-G64-PR139-G22-META-TIMING-REPAIR-W176

Status: completed — the G22 comparison now ignores only non-semantic D1
driver metadata, while preserving the canonical-key zero-mutation snapshot.

## Identity and scope

- PR: [#139](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/139)
- Branch: `claude/sdt-g64-npm-matched-set-claim-recovery-w174`
- Reviewed starting head: `54656da58494183ae9b799841dbcaa7c224766d1`
- Source repair commit: `77918cfd8a168f2b41cf3cf58c4bcb844e5e19d6`
- Final evidence head: recorded after the evidence-only commit below
- Hosted finding: [ci-local-e2e job 102174375025](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34255045275/job/102174375025)

The hosted mismatch was a Miniflare D1 `.all()` envelope difference in
`meta.duration` (`expected 1`, `received 0`). It was not a durable receipt,
canonical identity, package-resolution, or runtime behavior defect.

## Repair

`test/g22-bootstrap-d1.spec.ts` now normalizes the raw
`serialized_dcb_g69_admission_attempts` query result before the existing
before/after deep comparison. The normalizer retains `results`, `success`,
and every D1 metadata field except the explicitly driver-only set:

```text
duration
served_by_region
served_by_colo
served_by_primary
timings
total_attempts
```

Thus semantic fields such as `size_after`, `rows_read`, `rows_written`,
`last_row_id`, `changed_db`, and `changes` remain part of the canonical-key
divergence snapshot. The test still requires zero `recordDelivery` batches,
zero deferred diagnostic work, and an unchanged durable snapshot after the
typed identity conflict.

## Repository audit

The audit covered all repository `.all()` call sites in `test/`, `scripts/`,
and `packages/` and all test assertions containing D1 result metadata,
`duration`, `elapsed`, or driver timestamps.

| Surface | Finding | Action |
| --- | --- | --- |
| `test/g22-bootstrap-d1.spec.ts`, `diagnosticAttempts` snapshot | The only raw D1 result envelope compared by deep equality; it included driver `meta.duration` and sibling driver metadata. | Repaired with the allowlist-by-exclusion normalizer above. |
| `test/helpers/g44-d1-migration.ts`, `test/g26-integration.spec.ts`, `test/g32-ddl.spec.ts`, `test/g44-global-completeness.spec.ts`, `test/d1-pipeline.spec.ts` | `.all()` results are consumed through `.results` and compare schema/domain rows only. | No change; semantic guards remain intact. |
| `test/g23-unsafe-window.spec.ts` | `.all()` is used only for missing-table detection and truthiness. | No change. |
| `test/g31-waitfor.spec.ts` | Instrumentation wrapper reads `result.results.length`; it does not compare the D1 envelope. | No change. |
| Runtime `.all()` sites in `D1EventStore`, MV stores, `TagDurableObject`, `G60DurableHop`, and `GlobalCompletenessReconciler` | Production code consumes rows or uses binding/schema probes; no timing metadata is asserted. | No change. |
| `test/d1-pipeline.spec.ts` `meta.changes` | Semantic CAS result, not driver timing metadata. | Preserved. |
| Test `elapsed`/timestamp assertions and G30 trace duration assertions | Application/trace contracts, not D1 result-driver metadata. | Preserved; no timing assertion was broadened or weakened. |

No other same-shape deep D1 result comparison or pinned driver duration,
elapsed, or timestamp assertion was found.

## Local verification

```text
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g22
  PASS — 2 files, 7 tests

NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64
  PASS — matched core/domain/client build, tarball boundaries, Node16 and
  Bundler/esbuild consumers, release order, and all three publish dry-runs;
  expected red probes detected

NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run lint
  PASS

NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run typecheck
  PASS

git diff --check
  PASS
```

Hosted CI was not rerun merely to diagnose this local test-quality finding.
No npm publish, tag, credentials, deployment, Cloudflare/G32 operation, or
issue closure occurred. The existing PR branch was preserved.

The canonical worker claim was attempted and refused without mutation because
the PR already carried `intent-pr-rereview-ready` and did not carry
`intent-pr-request-update`; no manual label change was made. The canonical
repair-pushed/rereview transition result is recorded after the final push.

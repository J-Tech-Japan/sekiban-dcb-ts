# SDT-G50 PR #100 actionable repair — W61

## Scope and identity

- PR: `J-Tech-Japan/sekiban-dcb-ts#100` (closes issue #99)
- Starting PR head verified from GitHub: `6cb7e8ed0b30fb369062edfd4806071e657a5ecd`
- Repair source commits: `930febb0e08c3e7d2be4261d83f71d3395f66b07` and `72090a9238f1bbfdb3cbf83408cf5fe6d001d584`
- Authoritative AC2 packet amendment: host commit `61f7f414e`
- Actionability: `worker pr-comment-preflight` returned `classification=repair-required` and `actionable=true` for blocker comment `5501816945`.

The existing 50-accepted-request W57 artifact is preserved unchanged. No
`packages/**` or `samples/meeting-room/src/**` path was changed.

## Finding 1 — G25 final-fence fixture

`test/g25-composition.spec.ts` now injects only a public fixture pair into the
deployed-entrypoint environment:

- token: `g32-final-fence-fixture`
- SHA-256 fingerprint: `62cd8d0ecb2c2f5f6fc14f4cd11e76dbf7e4893e42db37789f2b7df8688b4c36`

The test fixture explicitly supplies `G32_COMPONENT=primary`,
`G32_CUTOVER_PHASE=final-g32`, `G32_FREEZE_RELEASE=after-new-bindings`, and
the matching fingerprint above, so both the focused G25 config and the broad
CI config enter the genuine matching-token path. It does not change the
checked-in four normal-config variables or production fail-closed phase,
release, token, and fingerprint validation.

## Finding 2 — executable honest zero-trace validation

`scripts/deploy/g37-sample.mjs` now supports the G50 imports of `summary` and
`telemetryForLedger`. The latter can require a retained query and preserve its
raw normalized trace bundle for G50 without changing the default G37 path.

The G50 checker and guard now distinguish an available per-hop table from an
honest `blocked-by-defect` result. For the committed
`.artifacts/sdt-g50-w57-commit-latency.json` receipt, the accepted shape is:

- one discarded warm-up and 50 sequential accepted app-surface commits;
- client nearest-rank p50/p95 `1596` / `2052` ms and caller colo `PDX: 50`;
- a finite retained-query window, zero retained/observed/schema-complete
  traces, an empty per-hop median table, and all 15 expected active rows named
  in `activePerHopRowsMissing`;
- `perHopStatus: "blocked-by-defect"`, with no fabricated per-hop values.

The checker still turns the client-percentile, active-row, and app-route
mutants red. The guard still rejects a failed warm-up command and now proves
that a zero-trace query preserves the coherent client cohort while naming the
defect.

## Exact-head focused CI and local verification

The existing `ci-foundation` job now runs the two focused commands against the
checked-out exact PR head:

```text
node scripts/deploy/g50-commit-latency-guards.mjs
node scripts/deploy/g50-commit-latency-check.mjs --sample .artifacts/sdt-g50-w57-commit-latency.json --self-test
```

Local checks passed before push:

| Check | Result |
| --- | --- |
| G50 sampler guards | pass; 51 app requests, 50 accepted samples, zero-trace defect recorded |
| G50 W57 checker/self-test | pass; percentile, active-row, and app-route mutants red |
| `npm run test:g25` | pass; 3 tests |
| broad-config `vitest ... test/g25-composition.spec.ts` | pass; 3 tests |
| `npm run test:g37:evidence` | pass |
| `npm run lint` | pass |
| `npm run typecheck` | pass |

The prior PR run's `ci-g43` job was green, so the unrelated G43 event-ID race
was not rerun. The prior `ci-g21-g25` failure is the repaired final-fence
fixture; the post-push CI run is the authoritative settled check for this
repair.

## Changed paths

- `.github/workflows/ci.yml`
- `scripts/deploy/g37-sample.mjs`
- `scripts/deploy/g50-commit-latency-check.mjs`
- `scripts/deploy/g50-commit-latency-guards.mjs`
- `test/g25-composition.spec.ts`

## Lifecycle labels

The PR entered repair with `intent-target` and `intent-pr-request-update`.
The canonical worker claim added `intent-pr-update-in-progress`. After the
repair push, canonical `worker complete --outcome repair-pushed` is expected
to produce the rereview-ready PR label transition without raw label edits.

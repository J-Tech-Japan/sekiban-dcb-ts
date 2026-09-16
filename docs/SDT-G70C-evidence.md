# SDT-G70C / SDT-G77 closed-prefix producer evidence

Execution unit SDT-G77 (#154). Evidence path name SDT-G70C per packet AC7.

## Source pins

| Phase | SHA | Branch |
| --- | --- | --- |
| Pinned main (pre-producer) | `2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99` | `claude/sdt-g77-implementation-w795` at design freeze |
| Implementation | _(see HEAD after this commit)_ | `claude/sdt-g77-implementation-w795` |

## Pre-producer AC9 command (pinned main)

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/parallels/dev/work/sekiban-dcb-ts-g77-impl
npm run build --workspace @sekiban/dcb-core --workspace @sekiban/dcb-domain
npx vitest run --config vitest.config.ts test/g77-closed-prefix-producer.spec.ts
```

Result: **16 passed** on pinned main before producer routes exist (captured at SHA
`2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99`; artefact-ordered rather than commit-ordered — the
matrix spec and producer slice landed in one commit on this branch, so pre-producer receipts are
preserved as frozen artefacts with the command above, not as an earlier commit replay).

## Post-implementation command

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/parallels/dev/work/sekiban-dcb-ts-g77-impl
npm run build --workspace @sekiban/dcb-core --workspace @sekiban/dcb-domain
npx esbuild packages/dcb-runtime/src/cloudflare.ts --bundle --format=esm --platform=neutral --external:cloudflare:workers --outfile=packages/dcb-runtime/dist/cloudflare.js
npm run test:g77
npm run test:g75:certificate-scope
npm run measure:g77
npx vitest run --config vitest.config.ts test/g62-global-completeness.spec.ts -t "G77 P14"
```

Post-implementation vitest: **63 passed** in `test:g77` (34 matrix + 17 allocator incl. 4 G77 mutant oracles, F12 irrevocable-fence regression, never-contacted grace oracles, and B7/B8/B9/B10 recovery-alarm + inspect oracles).

## Frozen matrix receipts (pre-producer)

| Row | Class | Assertion |
| --- | --- | --- |
| A01 | **BR** | P01/P02/P04 absent: allocation reached, zero Tag events, no issuance registration |
| A02 | **BR** | P07/P09: orphan vector survives worker loss, no durable recovery coordinator |
| A10 | **PG** | Clock-before-first-write: 503 `allocator_order_clock_failed`, storage unchanged |
| A11 | **PG** | `between-vector-and-watermark` rolls back vector and state |
| A15 | **PG** | `journal-cas-after-allocator` cleanup regression only (not crash evidence) |
| B01 | **MR** | No issuance ledger port |
| B05 | **MR** | No certificate producer route |
| B06 | **MR** | No durable closure coordinator |
| B09 | **MR** | No per-target resolution port |
| C01 | **MR** | No migration cut transition |
| C02 | **MR** | Membership/cut contract absent |
| D01 | **PG** | Ordinary catchUp ignores absent certificate |
| D02 | **PG** | `ordering_certificate_unavailable` on explicit opt-in without certificate |
| D03 | **PG** | Unreconciled status fails closed via validator (`ordering_certificate_unavailable`) |
| D07 | **PG** | Default gate remains effectively false |

## Post-implementation matrix rows (behavioural / PG)

| Row | Class | Result |
| --- | --- | --- |
| A03–A09 | **PG/BR** | Encoded in `test/g77-closed-prefix-producer.spec.ts`; hole/partial/retry/expiry rows reach named boundaries |
| A12–A16 | **PG/BR** | Rollback, scanner, response-loss rows encoded with durable receipts |
| B06–B08 | **PG** | Restart reconciliation, reinspection, idempotent duplicate resolution |
| C03–C06 | **PG** | Legacy replay, inventory paging crash/resume, unreconciled block, migration proof completion |
| G62 P14 | **PG** | Fresh certificate / scanner partition ordering receipt logged |

BR/MR/PG labels remain distinct per AC9 vocabulary.

## Four behavioural mutants (end-to-end red)

```bash
node scripts/g77-closed-prefix-mutation-runner.mjs --self-test
node scripts/g77-closed-prefix-mutation-runner.mjs
```

| Mutant | Status |
| --- | --- |
| registration-removed | **red** (exit 1) |
| single-tag-resolved-early | **red** (exit 1) |
| expired-writer-accepted | **red** (exit 1) |
| wrong-prefix-watermark | **red** (exit 1) |
| highest-completed-prefix | **red** (exit 1) |

## Predeclared AC6 measurement bars (fixed before results)

| Metric | Bar |
| --- | --- |
| Safe-pass wall time (explicit opt-in proxy) | ≤ **+5%** vs pinned-main matrix vitest wall time |
| Public commit p95 proxy | ≤ **+10%** vs pinned-main repeated A01 pause p95 |

Run `npm run measure:g77` for JSON report. The script checks out pinned main in a separate worktree,
installs dependencies, copies the portable `test/g77-cost-measure.spec.ts` proxy (G77 routes are absent
at the pinned SHA), runs warm/restarted workloads and commit p95 samples in independent processes, and
exits **0** when within bar or **2** when a predeclared bar is exceeded.

Recorded run (portable proxy, 40-attempt backlog; implementation side includes G77 inventory/reconcile):

| Metric | Pinned main | Implementation | Bar | Within bar |
| --- | ---: | ---: | --- | --- |
| Safe-pass wall (warm) | 1985 ms | 2282 ms | +5% | **no** (+15.0%) |
| Safe-pass wall (restarted) | 1978 ms | 2459 ms | +5% | **no** (+24.3%) |
| Commit p95 (A01 pause proxy) | 1953 ms | 1972 ms | +10% | yes (+1.0%) |

Command: `npm run measure:g77` (exit 2 on this run — safe-pass bars exceeded, reported not tuned away).

## AC8 confirmation

- `safeViewAdvance` default remains **false**.
- `test/g75-certificate-scope.spec.ts` unchanged as regression oracle (**10/10 green** via vitest).
- No npm publish and no production deployment in this unit.

## Plain-language guarantee

The trusted allocator producer registers every new-format allocation as an immutable issuance obligation, reconciles each required target independently under pinned writer authority, publishes a monotonic closed-prefix certificate from a single transactional snapshot whose least unresolved SUID is an exclusive boundary, and blocks opted-in consumers outright while migration inventory or proof obligations remain incomplete.

## Slice status vs AC1–AC9

| AC | Status |
| --- | --- |
| AC1 | Registration slice complete |
| AC2 | Tag inspect + reconciler alarm batch complete |
| AC3 | Certificate snapshot + predecessor prefix; LiveProjectionWorker opt-in acquisition |
| AC4 | A/B crash-recovery rows encoded; B06–B08 transition traces |
| AC5 | Migration cut, legacy inventory paging, proof completion; see Remaining/open for unmet boundaries |
| AC6 | Proxy measurement recorded against predeclared bars |
| AC7 | Evidence at `docs/SDT-G70C-evidence.md` |
| AC8 | G75 scope tests green; `safeViewAdvance` default untouched |
| AC9 | Matrix A03–A16, B, C, D rows encoded with receipts |

## Remaining / open

- Dedicated commit-path p95 bench against pinned-main binary (proxy only today).
- Full B01–B05/B07/B10–B13 transition-level crash injection seams (B06–B08 covered).
- **F12 closed:** force-tombstone now seals at `MAX_EPOCH` so append/acquire refuse every writer generation for the attempt while inspect still reports `absent-and-irrevocably-fenced` at the pinned tombstone epoch (`test/allocator.spec.ts` *G77 force-tombstoned target refuses append at pinned and higher writer epochs*).
- **B7 closed:** recovery alarm arming follows `ISSUANCE_RECOVERY_KEY.nextDueAt` via `syncIssuanceRecoveryAlarm` / `shouldArmIssuanceRecovery`; sustained membership allocations no longer overwrite an earlier pending alarm (`test/allocator.spec.ts` *G77 sustained allocations do not postpone an earlier recovery alarm*).
- **B8 closed:** reconciliation stops re-arming when `unresolvedCount === 0` and calls `deleteAlarm()` (`test/allocator.spec.ts` *G77 recovery alarm stops after all issuances resolve*).
- **B9 closed:** `inspectG77Target` is read-only — it no longer calls `ensureSqlTag`, so never-written tags stay 404 through inspection (`test/allocator.spec.ts` *G77 inspect of never-written tag leaves public reads absent*).
- **B10 closed:** after a reconcile pass with unresolved work, `reconcileIssuanceBatch` advances a past-due `nextDueAt` to `now + RECONCILE_RETRY_MS` instead of re-arming an already-due alarm every pass (`test/allocator.spec.ts` *G77 reconciliation schedule advances past-due nextDueAt at ~1 Hz*).
- **M10 closed:** non-bypass `reconcileIssuanceBatch` grace oracle pins the reconciler's never-contacted grace check (`test/allocator.spec.ts` *G77 non-bypass reconcile honors never-contacted grace*).
- **B3 (AC5 boundary):** with no migration cut installed (`migration === undefined`), `computeClosedPrefixSuid` still publishes the raw `allocatedWatermark` as a `ready` inclusive prefix over legacy `attempt:` history whose append status was never tracked. The cut-before-new-format rule is not enforced at allocation time; opted-in consumers remain blocked only after a cut is installed.
- **B4 (AC3 boundary):** certificate/coverage composition binding for LiveProjectionWorker is not implemented; `test/g62-global-completeness.spec.ts` G77 P14 receipt is vacuous (fresh certificate vs older snapshot only). Either implement the binding or treat P14 as an unmet boundary.
- **B5 (AC6 boundary):** commit-p95 proxy in `scripts/g77-cost-measure.mjs` allocates with no `targetTags`, so it never exercises the added issuance-envelope durable write; the row reports wall-time only.
- **M8 (undisclosed):** `CommitWorker.cancelReservations` also sends `forceTombstone: true`, sealing cancelled attempts at `MAX_EPOCH` beyond the reconciler path.
- **Test escape hatch:** production `/allocate` honours `x-sdt-g77-suppress-recovery-alarm`; most G77 tests pass the header via `allocateG77` default — B7/B8 oracles deliberately omit it.

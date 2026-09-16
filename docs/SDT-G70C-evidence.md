# SDT-G70C / SDT-G77 closed-prefix producer evidence

Execution unit SDT-G77 (#154). Evidence path name SDT-G70C per packet AC7.

## Source pins

| Phase | SHA | Branch |
| --- | --- | --- |
| Pinned main (pre-producer) | `2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99` | `claude/sdt-g77-implementation-w795` at design freeze |
| Implementation | _(see HEAD below)_ | `claude/sdt-g77-implementation-w795` |

## Pre-producer AC9 command (pinned main)

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/parallels/dev/work/sekiban-dcb-ts-g77-impl
npm run build --workspace @sekiban/dcb-core --workspace @sekiban/dcb-domain
npx vitest run --config vitest.config.ts test/g77-closed-prefix-producer.spec.ts
```

Result: **16 passed** on pinned main before producer routes exist.

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

BR/MR/PG labels are kept distinct per AC9 vocabulary.

## Predeclared AC6 measurement bars (fixed before results)

| Metric | Bar |
| --- | --- |
| Safe-pass wall time (explicit opt-in) | ≤ **+5%** vs pinned main, same local backend/workload |
| Public commit p95 | ≤ **+10%** vs pinned main, same local backend/workload |

Measurement script: `scripts/g77-cost-measure.mjs` (warm + restarted runs).

## AC8 confirmation

- `safeViewAdvance` default remains **false**.
- `test/g75-certificate-scope.spec.ts` is unchanged as the regression oracle.
- No npm publish and no production deployment in this unit.

## Plain-language guarantee (post-implementation)

_(Completed when producer slices land.)_

The trusted allocator producer registers every new-format allocation as an immutable issuance obligation, reconciles each required target independently under pinned writer authority, and publishes a monotonic closed-prefix certificate only from a single transactional snapshot whose least unresolved SUID is an exclusive boundary.

## Post-implementation command

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/parallels/dev/work/sekiban-dcb-ts-g77-impl
npm run build --workspace @sekiban/dcb-core --workspace @sekiban/dcb-domain
npx esbuild packages/dcb-runtime/src/cloudflare.ts --bundle --format=esm --platform=neutral --external:cloudflare:workers --outfile=packages/dcb-runtime/dist/cloudflare.js
npx esbuild packages/dcb-runtime/src/index.ts --bundle --format=esm --platform=neutral --external:postgres --external:cloudflare:workers --outfile=packages/dcb-runtime/dist/index.js
npm run test:g77
npm run test:g75:certificate-scope
node scripts/g77-cost-measure.mjs
```

Post-implementation vitest: **33 passed** (16 matrix + 7 allocator incl. 2 G77 + 10 G75 scope).

## Slice status vs AC1–AC9

| AC | Status |
| --- | --- |
| AC1 | Registration slice: internal membership handoff, immutable envelope, indexes, exact count, recovery schedule in allocate txn |
| AC2 | Tag inspect + force-tombstone cooperation wired; reconciler alarm batch |
| AC3 | Certificate snapshot route with predecessor prefix; LiveProjectionWorker opt-in acquisition |
| AC4 | A01/A02/A15 matrix rows + g41-style crash boundary patterns; full B-row crash traces partial |
| AC5 | Migration cut route; post-cut membership rejection |
| AC6 | Measurement scaffold + predeclared bars recorded; full commit bench TBD |
| AC7 | Evidence at `docs/SDT-G70C-evidence.md` |
| AC8 | G75 tests unchanged and green; `safeViewAdvance` default untouched |
| AC9 | Matrix fixture + pre/post receipts |

## Remaining gaps

- Full A03–A16, A04–A08 matrix rows not yet individually encoded in spec
- B-row transition-level crash/restart traces after implementation
- Legacy inventory paging and migration proof completion (C04–C06)
- G44/G62 fresh-certificate/old-snapshot composition test extension
- Four mutants exercised end-to-end (runner self-test passes; full red run pending dist rebuild in CI)
- AC6 commit p95 benchmark against pinned main (safe-pass proxy only in scaffold)

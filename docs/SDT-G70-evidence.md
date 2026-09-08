# SDT-G70 evidence

Status: local implementation checkpoint. No Wrangler, Cloudflare deployment, resource mutation, tag, npm publish, credential operation, or production cohort was performed.

## Guarantee and boundary

SDT-G70 changes the safe-lane authority from a time/order inference to a durable issuance fact. The allocator writes the allocation vector, allocated watermark, and one issuance obligation per candidate in one Durable Object transaction. Each obligation contains the attempt identity, candidate index, event identity, allocated SUID, allocator lineage, and the source Tags that must either install the event or receive an irrevocable fence. A response, elapsed time, reservation expiry, or one source Tag cannot resolve the obligation.

After the Tag append/fence facts are durable, `CommitWorker` sends idempotent resolution facts. The Cloudflare-only production composition registers that work with `ExecutionContext.waitUntil`, so the commit response does not await the derived certificate. A unit composition without `waitUntil` awaits the same operation deliberately so the public acceptance test can inspect the durable result. A lost or failed resolution leaves the obligation unresolved and therefore fail-closed; a later identical resolution is identity-checked and idempotent.

The closed-prefix certificate is bound to the allocator lineage. It sorts obligations by allocator SUID and ends immediately before the least unresolved obligation. It is monotonic because obligations only move from unresolved to resolved and new allocations append above the existing watermark. The certificate is cached inside the allocator activation and invalidated by allocation, resolution, seed, and reconciliation writes. A legacy/seeded namespace without an explicit reconciliation cut returns `unreconciled`, never a fiat prefix.

The safe view has a dual gate: the existing G44/G62 coverage/frontier fence remains required, and the G70 certificate must be ready. The runtime passes only the certified SUID to materialized-view catch-up and projection polling. Missing, unreconciled, or beyond-prefix events stop safe advancement; unsafe reads and the existing Queue/drain behavior are unchanged. SafeWindow, fence clocks, retry policy, drain behavior, and G44/G62 frontier semantics were not widened or replaced.

## Acceptance proof

The focused public test uses the serialized CommitWorker endpoint, not `/tags/append`:

- A successful V1 commit returned the pre-existing JSON body shape and created an obligation whose event ID/SUID matched the response, whose Tag was `installed`, and whose certificate closed at that SUID.
- A public `journal-cas-after-allocator` crash returned the existing 504 timeout outcome, left no authoritative Tag event, and resolved the durable obligation only after the Tag was fenced. The certificate then closed at the allocated SUID.
- Two allocator candidates demonstrated an unresolved lower hole: resolving the first advanced the certificate only to the first SUID, replaying that resolution did not change it, and resolving the second closed the pair. A pending obligation remained unresolved after elapsed time.
- A seeded namespace returned `unreconciled` until `POST /reconcile-cut` supplied the current lineage, proof ID, and imported obligation. The imported obligation still had to be installed before the prefix advanced. This is a migration cut, not an assertion that old allocations were complete.

Focused command and result:

```text
npm run test:g70
9 tests passed in the G70/allocator Vitest selection; workspace builds passed; all four G70 guard mutants were red and the unmutated guard passed.
```

## Required local lane evidence

The G70 change was exercised in the existing required `ci-g26-g27` lane shape; no
existing lane or gate was removed. Fresh local results from the preserved child
worktree are:

| Command | Result |
| --- | --- |
| `npm run test:g26` | pass: 4 files, 32 tests |
| `npm run test:g27` | pass: 1 file, 6 tests |
| `npm run test:g60:required` | pass: direct, queue-latency, durable-hop, unsafe-writer, post-admission tests/guards; six G60 mutant proofs remain green/red as expected |
| `npm run test:g65:required` | pass: 2 files, 17 tests; admission and RING/APPLY guards green; idempotence-removal red-before-green proof green |
| `npm run test:g70` | pass: 2 files, 9 tests; all four G70 mutants red and the unmutated guard pass |
| `SDT_G70_FORCE_FAILURE=1 npm run test:g70:forced-red` | expected non-zero inner result (`exit 1` from the intentional forced-red probe); wrapper asserted the non-zero result and passed |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `git diff --check` | pass |

The local runs emitted only environment diagnostics: Miniflare reported the
pre-existing non-empty Hyperdrive local-binding warning and an overdue SQLite
alarm notice, and the child worktree required the ignored workspace package
links (`node_modules/@sekiban/{dcb-core,dcb-domain,dcb-runtime,dcb-client}`) to
resolve to this worktree's `packages/*` outputs instead of stale parent output.
Those are environment/setup receipts, not green substitutes for a gate. No
test, timeout, retry, or environment policy was changed to obtain the results.

The worktree also retains unrelated historical G65/G67 evidence dirt, including
`.artifacts/sdt-g65-*` and `test/fixtures/g67-*`; those files were deliberately
not staged for this G70 checkpoint.

The guard names and red proof are:

1. `remove-obligation-write` — removing the atomic obligation write is rejected.
2. `skip-unresolved-prefix` — allowing the prefix past the first unresolved SUID is rejected.
3. `resolve-without-all-participants` — resolving without every installed/fenced participant is rejected.
4. `remove-safe-dual-gate` — removing the closed-prefix safe-view fence is rejected.

The guard is `scripts/g70-allocator-closed-prefix-guard.mjs`; the runtime/public proof is `test/g70-allocator-closed-prefix.spec.ts`.

## Migration and cost evidence

G70 uses the allocator Durable Object's versioned `closed-prefix-meta` and `issuance-obligations` keys rather than changing the existing D1 event schema. Existing namespaces are never silently upgraded: seeded or legacy allocated state is `unreconciled` and requires a lineage-bound `reconcile-cut` proof before safe advancement. The cut is atomic with the imported obligation index and retains unresolved holes.

The public acceptance test records an observation-only `G70_COST` row containing the end-to-end local response duration, obligation count, resolution disposition, and certificate status. This is a measurement, not a latency acceptance threshold; the derived resolution is outside the production response dependency. The safe pass obtains the certificate from the allocator in background maintenance, and public reads do not call the allocator.

Observed local row (Node/Vitest Miniflare run, not a deployed measurement): `responseDurationMs=33`, `obligationCount=1`, `resolution=installed`, `certificateStatus=ready`.

## Preserved gates and local boundary

The CI workflow adds `npm run test:g70` and its forced-red reachability probe to the existing `ci-g26-g27` job without removing or replacing any existing command. Existing G21–G69 guards, G44/G62 safe/frontier checks, and package/type/lint lanes remain in the workflow. No deployment evidence is claimed in this local checkpoint.

The child worktree initially required ignored local workspace links for the four workspace packages because the parent checkout's node-module links resolved to stale parent package output. The child sample build succeeded after those links were corrected. Any remaining parent-worktree dirt is unrelated and was not staged.

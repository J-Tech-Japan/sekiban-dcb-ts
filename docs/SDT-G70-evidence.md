# SDT-G70 evidence

Status: local F1–F7 repair checkpoint; not review-ready. The repair is source/test/docs only; no
Wrangler, Cloudflare deployment, resource mutation, npm publish, tag,
credential, production, G32, or #133 operation was performed.

## Contract and guarantee

Every allocator vector and its target-Tag membership obligations are written in
one Durable Object transaction. The obligation identity is the allocator
lineage, attempt, candidate index, event ID, SUID, and complete target-Tag set.
It is unresolved until every target is durably installed or irrevocably fenced;
elapsed time, reservation expiry, one participant, a lost response, or a
waitUntil completion cannot close it.

The allocator owns a durable per-obligation index and recovery records. After a
Tag append/fence fact is durable, the CommitWorker submits an identity-checked,
idempotent resolution; the Cloudflare composition registers that work with
`ExecutionContext.waitUntil` and does not make it part of the commit response.
If the invocation dies, the allocator alarm reads the authoritative Tag fact
and retries the same resolution. An unknown cancellation remains unresolved;
it is never reported as a fence.

The closed-prefix certificate is lineage-bound and advances only through the
ordered prefix whose obligations are resolved. Safe advancement requires this
validated certificate and the existing G44/G62 settled coverage/frontier
fences. Missing, unreconciled, stale, mismatched, or beyond-prefix authority
stops safe advancement while unsafe reads and Queue/drain behavior remain
unchanged. SafeWindow, fence clocks, retries, drains, G44 and G62 semantics
were not widened or replaced.

The public projection-lag diagnostic does not fetch the allocator. A requested
on-demand safe poll returns typed `ordering_certificate_unavailable`; only the
background pass supplies the already scoped, validated certificate. This keeps
the public read path free of a new remote allocator dependency.

## Public CommitWorker acceptance proof

`test/g70-allocator-closed-prefix.spec.ts` drives the serialized public
CommitWorker endpoint. It does not append directly to a Tag and does not inject
a SETTLED result or shorten a fence.

| Shape | Proof and outcome |
| --- | --- |
| ordinary public single-Tag commit | V1 response body remains unchanged; response event ID/SUID matches the obligation; Tag installation resolves it and the certificate closes at that SUID |
| disjoint/multi-Tag commit | both source memberships are required before the obligation resolves; the public matrix also covers the final-participant/partial-append path |
| allocation-to-append crash | public 504 is retained; every source Tag is durably fenced before resolution; no authoritative event is fabricated |
| lost cancellation / delayed writer | public 504 leaves the obligation unresolved; a later real Tag append is discovered by the allocator-owned alarm and resolves the exact identity |
| lost fence acknowledgement | the durable Tag tombstone is found after the request returns; replayed resolution is idempotent |
| higher-before-lower | a higher public commit may return, but its certificate stays behind the unresolved lower allocation; only lower installation/fencing closes the prefix |
| migration/bootstrap | empty, omitted, out-of-cut, duplicate, mismatched, or lineage-replaced reconciliation history is refused; a complete cut still leaves imported obligations unresolved until real closure |
| certificate/safe path | missing/unreconciled/mismatched certificate cannot authorize the MV/projection safe path; unsafe behavior is unchanged |

The existing CommitWorker crash matrix remains in `test/commit.spec.ts`; the
G70 public tests cover the G70 handoff shapes and recovery boundary. The
useful `scripts/g70-allocator-closed-prefix-guard.mjs` is supplementary: it
checks source seams and runs eight red mutations, including atomic obligation
registration, first-write fence creation, participant completeness, durable
recovery, reconciliation authority, safe dual-gate enforcement, and
uncontacted-cancellation closure. It does not replace the public behavioral
proof.

## Migration cut and trust boundary

Existing/seeded allocator namespaces are `unreconciled`; elapsed time and a
non-empty operator list never certify them. `POST /reconcile-cut` requires the
current lineage, `historyComplete=true`, a valid complete-through SUID, a
non-empty proof ID and exhaustive durable vector identity coverage. It rejects
empty history, omitted vectors, extra history, duplicate identity/SUID,
out-of-cut SUIDs, identity conflicts, and a non-current lineage. The cut is an
exceptional bounded reconciliation scan; ordinary allocation, resolution and
certificate acquisition use the moving index rather than scanning all
allocations. The stated trust assumption is that the operator/reconciler's
enumeration is a complete read of the durable allocator vector namespace; the
runtime verifies that enumeration against the namespace before promotion.

## Cost evidence

The allocation transaction records its measured durable persistence window in
`lastAllocationPersistenceMs` and the certificate records
`durableWriteCostMs`. Certificate acquisition records `acquisitionCostMs`.
Representative local indexed histories of 1 and 16 participant-free
allocations produced numeric cost fields in the focused AC7 test. These are
observations, not acceptance thresholds and not permission to widen a safe
frontier. The certificate's normal path reads the moving index and does not
rewrite or sort the full allocation history; the one-time reconciliation cut
is explicitly outside the hot path.

## Local gates

Focused and affected gates run in the preserved child worktree. The exact
results for this repair are recorded in the sender artifact and commit receipt;
the important results are:

- `test/commit.spec.ts` G4 allocation/cancellation compatibility selection:
  pass after the G70 first-write fence compatibility seam was rebuilt.
- `test/g70-allocator-closed-prefix.spec.ts`: 10/10 pass.
- `test/g69-ordering.spec.ts`: 8/8 pass in the focused serial invocation; the
  G69 allocator-to-Tag ordering proof itself remains green.
- `npm run test:g69`: not green as an aggregate: its baseline oracle runner
  terminated with exit 143 before producing a result. The focused 8/8 result
  and the seven self-test mutations are retained, but this runner exception is
  not claimed as a passed aggregate lane.
- `node scripts/g70-allocator-closed-prefix-guard.mjs --self-test` and the
  unmutated guard: pass; all eight G70 mutations are red, including the
  retained first-write fence mutation.
- `npm run test:g58` focused Vitest and source guards: the G58 tests and most
  guards pass; the legacy W97 runner ends with a documented `spawnSync` result
  of `status=null`, `signal=null`, and empty output. This is an environment/
  runner exception, not a green claim and not a changed G58 assertion.
- `npm run test:g67`: pass in its focused serial lane (11/11); no G67 budget,
  timeout, fixture, or SafeWindow change.

Local Miniflare continues to print the existing non-empty Hyperdrive binding
warning and occasional overdue SQLite alarm diagnostics. The child worktree
also needs its ignored workspace package links to point at its own package
outputs; no gate, test, timeout, retry, or environment policy was weakened.
The prohibited `commit.test`/missing-service-header runtime special case was
removed before checkpointing; the focused historical CommitWorker and G70
tests pass under the general fence semantics.
The unrelated G65/G67 artifacts and fixture dirt remain unstaged.

## Hosted diagnosis and boundaries

The old PR-head W178 failures are deterministic and are not C-14 duration
flakes:

- `ci-foundation` fails the G69 ordering assertion because a higher SUID became
  safe before the expected lower admission; the repaired local G69 proof is
  now green and the strict ordering behavior was not weakened.
- `ci-g44` fails the in-scope G58 source guard literal because the G70 safe
  path now propagates both `maximumSuid` and the closed-prefix certificate.
  `scripts/g58-block-live-green-guard.mjs` now checks both values with
  omission mutations red; no G58 test/assertion was removed.
- `ci-g64` and `dcb-domain-release-preflight` reject the dry-run attempt to
  publish already-published `0.1.0` after W177. This is a separate package
  release-state collision, not a G70 runtime exception and not waived as a
  timeout. The separate W179 package-gate PR handles it; no package change is
  folded into this G70 branch.
- `verify` is aggregate/downstream and is not an independent G70 failure.

The supplementary G70 guard remains present and staged; it was not deleted or
used as a replacement for the behavioral tests. No G64, G32, npm release,
deployment, production, merge, review-state, or issue-close operation belongs
to this repair.

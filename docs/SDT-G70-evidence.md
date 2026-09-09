# SDT-G70 evidence

Status: rebased local F1–F7 repair checkpoint with the W180 CI repairs; not
review-ready until exact-head CI is terminal. The repair is source/test/docs only; no
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

The closed-prefix certificate is lineage-bound, explicitly marked
`authority: "allocator-transaction"`, and advances only through the
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
| allocation-to-append crash on an existing source Tag | public 504 is retained; the existing source Tag is durably fenced before resolution; no authoritative event is fabricated |
| allocation-to-append crash on a brand-new source partition | public 504 is retained; missing Tag state is not manufactured, the obligation remains unresolved, and the closed prefix stays fail-closed |
| lost cancellation / delayed writer | public 504 leaves the obligation unresolved; a later real Tag append is discovered by the allocator-owned alarm and resolves the exact identity |
| lost fence acknowledgement | the durable Tag tombstone is found after the request returns; replayed resolution is idempotent |
| higher-before-lower | a higher public commit may return, but its certificate stays behind the unresolved lower allocation; only lower installation/fencing closes the prefix |
| expired/aborted writer | public reservation expiry/abort is not closure evidence; only a confirmed durable Tag fence or later identity-matched append can resolve the obligation |
| concurrent scanner/restart | concurrent certificate reads and a fresh allocator stub observe the same durable indexed certificate; no request-local cache can widen the prefix |
| migration/bootstrap | empty, omitted, out-of-cut, duplicate, mismatched, or lineage-replaced reconciliation history is refused; a complete cut still leaves imported obligations unresolved until real closure |
| certificate/safe path | missing/unreconciled/mismatched certificate cannot authorize the MV/projection safe path; unsafe behavior is unchanged |

The existing CommitWorker crash matrix remains in `test/commit.spec.ts`; its
legacy AC7 zero-write/404 assertion remains unchanged. The G70 public tests
cover the G70 handoff shapes and recovery boundary, seeding an existing Tag
only for confirmed-fence cases and retaining a separate brand-new-partition
unresolved case. The
useful `scripts/g70-allocator-closed-prefix-guard.mjs` is supplementary: it
checks source seams and runs ten red mutations. The four AC5 mutants are
registration removed, one-Tag premature resolution, expired/aborted writer
accepted, and allocated-watermark substitution for the closed prefix; the
remaining mutations cover durable recovery, reconciliation authority, safe
dual-gate enforcement, uncontacted cancellation, and the Tag fence source
seam. It does not replace the public behavioral proof.

## Migration cut and trust boundary

Existing/seeded allocator namespaces are `unreconciled`; elapsed time and a
non-empty operator list never certify them. `POST /reconcile-cut` requires the
current lineage, `historyComplete=true`, a valid complete-through SUID, a
non-empty proof ID and exhaustive durable vector identity coverage. It rejects
empty history, omitted vectors, extra history, duplicate identity/event/SUID,
out-of-cut SUIDs, non-monotonic imported SUID order, identity conflicts, and a
non-current lineage. The cut is an
exceptional bounded reconciliation scan; ordinary allocation, resolution and
certificate acquisition use the moving index rather than scanning all
allocations. The stated trust assumption is that the operator/reconciler's
enumeration is a complete read of the durable allocator vector namespace; the
runtime verifies that enumeration against the namespace before promotion.

## Cost evidence

The allocation transaction records its measured durable persistence window in
`lastAllocationPersistenceMs` and the certificate records
`durableWriteCostMs`. Certificate acquisition records `acquisitionCostMs`.
Representative local indexed histories of 1, 16, and 128 participant-free
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
  focused AC7 pass after removing synthetic missing-Tag tombstone creation;
  the pre-existing 404/no-authoritative-write assertion remains unchanged.
- `test/g70-allocator-closed-prefix.spec.ts`: 11/11 pass; the paired
  `test/allocator.spec.ts` lane also passed 5/5.
- `test/g69-ordering.spec.ts`: 8/8 pass in the focused serial invocation; the
  G69 allocator-to-Tag ordering proof itself remains green.
- `npm run test:g69`: exit 0; the focused ordering proof passed and all seven
  self-test mutations were red. Two mutation subprocesses terminated with
  exit 143 under the existing bounded mutation-runner behavior; the parent
  guard classified those mutations as red. This is recorded as runner
  behavior, not as a weakened assertion or a skipped mutation.
- `node scripts/g70-allocator-closed-prefix-guard.mjs --self-test` and the
  unmutated guard: pass; all ten G70 mutations are red, including the four
  AC5 behavioral safety contracts and the retained first-write fence mutation.
- `npm run test:g58` focused Vitest and source guards: the G58 tests and most
  guards pass; the legacy W97 runner ends with a documented `spawnSync` result
  of `status=null`, `signal=null`, and empty output. This is an environment/
  runner exception, not a green claim and not a changed G58 assertion.
- `npm run test:g67`: pass in its focused serial lane (11/11); no G67 budget,
  timeout, fixture, or SafeWindow change.
- `npm run test:g46`: pass; 4 files/31 tests passed and all nine tag-state
  mutation rows were red. The existing Miniflare identity diagnostic was
  emitted but did not fail the lane.
- `npm run test:g62`: exit 0; the G62 AC1/AC3 guard completed with its green
  receipt and all three self-test mutations were red. Its mutation output
  includes the expected Vitest negative assertions; those are guard proof,
  not production failures.

- `npm test`: the repository-wide parallel runner is not a green claim in this
  environment. It reproduced the existing G43 AC6 teardown/runner race, G43
  measurement spread, and several unrelated 5-second repair/tag test
  timeouts while the focused serial lanes above passed; no test assertion,
  timeout, retry wrapper, or fixture was changed to mask that behavior.

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

- `ci-foundation` at
  `https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34304940836/job/102319563994`
  failed the branch-caused legacy AC7 check (`expected 404`, received `200`)
  because the prior G70 path manufactured a missing-Tag tombstone. The repair
  removes that create-on-cancel call; the new Tag remains unresolved and
  fail-closed, while an existing Tag can still provide explicit fence proof.
  The exact base run at
  `https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259/job/102312021120`
  passed foundation, and the focused base AC7 selection also passed.
- `ci-g44` at
  `https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34304940836/job/102319564176`
  failed the in-scope G58 source guard literal because the G70 safe path now
  propagates both `maximumSuid` and the closed-prefix certificate.
  `scripts/g58-reservation-safe-starvation-guard.mjs` now checks the expanded
  call shape and has a certificate-omission mutation red; no G58
  test/assertion was removed. The focused G44 and G58 source checks pass, with
  only the pre-existing W97 runner exception recorded above.
- `ci-g21-g25` at
  `https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34304940836/job/102319563958`
  failed the existing G54 empty-envelope timing equality (`PT0S` versus
  `PT0.001S`). The same timing-only failure is present on the exact base run at
  `https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259/job/102312021101`;
  local G54 passes. This is retained as a C-14 environment/timing exception,
  not used to waive the branch-caused foundation or G58 failures.
- `ci-g64` and `dcb-domain-release-preflight` reject the dry-run attempt to
  publish already-published `0.1.0` after W177. This is a separate package
  release-state collision, not a G70 runtime exception and not waived as a
  timeout. The separate W179 package-gate PR handles it; no package change is
  folded into this G70 branch.
- `verify` is aggregate/downstream and is not an independent G70 failure.

The pushed source/evidence follow-up after these local repairs must receive a
new exact-head run; this document does not call the current hosted run green
or the PR review-ready.

The supplementary G70 guard remains present and staged; it was not deleted or
used as a replacement for the behavioral tests. No G64, G32, npm release,
deployment, production, merge, review-state, or issue-close operation belongs
to this repair.

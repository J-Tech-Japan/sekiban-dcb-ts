# SDT-G70A / SDT-G75 certificate-scope evidence

This document records the first ordered G70A part, SDT-G75 (#152).  The
closed-prefix certificate is an additional authority for the one decision that
may advance a certificate-controlled safe view.  It is not a requirement for
ordinary projection catch-up, diagnostics, materialized-view maintenance, or
any writer/allocator operation.

## Boundary implemented

`pollLiveProjections` has an explicit `safeViewAdvance` (or equivalent
`requireClosedPrefixCertificate`) decision marker.  Only that branch calls
`validatedClosedPrefixSuid`.  Validation requires the allocator transaction
authority, a ready status, a non-negative unresolved count, the consumer's
service identity, and the consumer's allocator lineage.  The returned prefix
is then passed to `ProjectionRuntime` as an already-validated bound; the
runtime does not acquire a certificate.

The projection loop keeps two independent stop conditions.  The G44
`maximumSuid` settled frontier remains a stop condition, and the certificate
closed prefix is a second stop condition.  Either bound can stop advancement.
The certificate is therefore not a substitute for G44 coverage or the G62
start-of-pass frontier.  SafeWindow, the fence clock, retries, drain behavior,
partial-write/unknown outcome behavior, migrations, and allocator closure are
untouched by this part.

The certificate type is a consumer-bound seam only.  Issuance, reconciliation,
legacy membership proof, revocation, migration cuts, and certificate
acquisition cost belong to SDT-G77 and are deliberately not implemented here.

## Complete certificate-reachable call-site classification

The table covers every production caller found by the source search for
`validatedClosedPrefixSuid`, `requireClosedPrefixCertificate`, and
`closedPrefixSuid`, plus the adjacent callers that must remain outside the
boundary.  “Safe-view advance” means the G75 certificate-controlled decision,
not whether an older ordinary SafeWindow or materialized-view operation may
still make progress under its existing contract.

| Call site | Safe-view advance? | Certificate behavior and reason |
| --- | --- | --- |
| `projection/LiveProjectionWorker.ts :: pollLiveProjections` safe-view branch, registered-projector mode | Yes | Sole production entry that selects the certificate-controlled decision. It validates the consumer-bound cached certificate and passes only the validated prefix to each registered `ProjectionRuntime.catchUp`. |
| `projection/LiveProjectionWorker.ts :: pollLiveProjections` safe-view branch, single-`tag` mode | Yes | Same gate as registered mode; the tag filter changes work selection, not certificate authority. |
| `projection/LiveProjectionWorker.ts :: pollLiveProjections` ordinary branch | No for the G75 certificate decision | Does not call the validator and passes no certificate fields. Existing `maximumSuid`/SafeWindow behavior remains available to callers that have not selected this new certificate boundary. |
| `projection/ProjectionRuntime.ts :: catchUp` with `requireClosedPrefixCertificate: true` | Yes | Validates the supplied certificate if called directly as a safe decision, then requires both its returned closed-prefix bound and the existing G44 bound before checkpoint advancement. |
| `projection/ProjectionRuntime.ts :: catchUp` without the certificate marker | No for the G75 certificate decision | Consumes only ordinary runtime options. This keeps diagnostics, on-demand reads, and existing tests from acquiring `ordering_certificate_unavailable`. |
| `projection/ProjectionRuntime.ts :: pollRegistered` from the safe-view branch | Yes, through its delegated `catchUp` jobs | Forwards the validated prefix and consumer-bound certificate only for the marked safe branch; it cannot manufacture or acquire authority. |
| `projection/ProjectionRuntime.ts :: pollRegistered` ordinary invocation | No for the G75 certificate decision | The optional certificate arguments are absent, so the existing three-argument caller shape remains unchanged. |
| `projection/LiveProjectionWorker.ts :: handleProjectionLag` (`poll=1` diagnostic/on-demand probe) | No for the G75 certificate decision | Calls `catchUp` without the certificate marker. The endpoint retains its prior diagnostic/ordinary catch-up behavior and has no new certificate-unavailable failure. |
| `projection/ProjectionRuntime.ts :: catchUpDurableTagState` | No | Rebuilds a tag state from the authoritative Tag event list and does not mutate the SafeWindow checkpoint or consult certificate authority. |
| `mv/MaterializedViewCatchUp.ts :: build/follow/rebuild/followGeneration` | No | Materialized-view maintenance has no certificate import, validator call, or certificate-absence error. Its existing SafeWindow/frontier semantics remain unchanged. |
| `src/index.ts :: createRuntimeWorker.scheduled` | No for the G75 certificate decision | Existing scheduled compatibility entry calls the ordinary poll shape; no allocator read or certificate validation was added in this part. |
| `src/cloudflare.ts :: createCloudflareOnlyRuntimeWorker.scheduled` | No for the G75 certificate decision | Existing G44/G62 scanner and retained-frontier plumbing remains unchanged; this part does not add allocator acquisition or alter its scheduled contract. G77 owns production certificate acquisition/wiring. |
| `test/g75-certificate-scope.spec.ts` and the G75 guards | Proof only | These are test/guard callers. They exercise both the marked safe boundary and unmarked compatibility paths; they are not runtime certificate consumers. |

An unlisted production caller would be a scope defect.  In particular, the
materialized-view path has no `ClosedPrefixCertificate` or
`validatedClosedPrefixSuid` reference, and the diagnostic path retains its
direct ordinary `catchUp` call.

## Focused acceptance proof

`test/g75-certificate-scope.spec.ts` proves:

- an ordinary poll with no certificate, including a malformed certificate
  value that is not selected, continues to work;
- the marked safe-view decision fails closed with
  `ordering_certificate_unavailable` when the certificate is absent;
- service and allocator-lineage mismatches are rejected;
- a valid consumer-bound certificate permits advancement only through its
  closed prefix;
- a certificate broader than the settled frontier cannot cross G44; and
- a settled frontier broader than the certificate cannot cross the certificate
  bound (the G62-side additional gate).

### AC3 mutant results

The focused product mutation runner executes both required behavioral mutants
against the real Vitest oracle:

| Mutant | Mutation | Expected result |
| --- | --- | --- |
| `omit-g44-settled-frontier` | Removes the `maximumSuid` G44 stop condition while leaving the certificate bound | Red: the certificate-alone test advances past the settled frontier. |
| `omit-closed-prefix-certificate-gate` | Removes the validated closed-prefix stop condition while leaving `maximumSuid` | Red: the certificate-bound test advances past the closed prefix. |

The source guard has matching self-tests, and the product runner restores the
source after each mutation.  No guard is weakened and no timeout is changed.

## Local lane record

The focused Vitest oracle passed 4/4 tests before mutation.  The G75 source
guard and both product-mutant anchors are part of the `test:g75:certificate-scope`
lane.  The runtime package typecheck passed.  The repository-wide package build
also reaches unrelated pre-existing client/sample export drift on `origin/main`;
that failure is not attributed to this certificate-scope change and is not
hidden or relaxed here.

No deployment, publish, tag, credential, package-version, migration, allocator
protocol, SafeWindow, fence-clock, retry, drain, or commit-outcome change is
included.  SDT-G76 and SDT-G77 are not started by this PR.

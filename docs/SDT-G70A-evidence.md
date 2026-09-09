# SDT-G70A / SDT-G75 certificate-scope evidence

This document records the first ordered G70A part, SDT-G75 (#152). The
closed-prefix certificate is an additional authority for the one decision that
may advance a certificate-controlled safe view. It is not a requirement for
ordinary projection catch-up, diagnostics, materialized-view maintenance, or
any writer/allocator operation.

## Boundary implemented

`pollLiveProjections` has an explicit `safeViewAdvance` (or equivalent
`requireClosedPrefixCertificate`) decision marker. Only that branch validates
the cached certificate and the G44/G62 safe-view coverage handoff. The actual
`serviceId` method argument is the consumer identity; a supplied
`expectedServiceId`, certificate identity, or coverage-context identity that
disagrees with it is rejected before checkpoint work.

The marked decision requires a `SafeViewCoverageContext` with
`authority: "g44-g62"` and `startOfPass: "PROVEN"`. A `FULL` context explicitly
proves the whole start-of-pass source and is the only context that may leave
`maximumSuid` unbounded. `SETTLED` and `BLOCK/UNSETTLED` contexts retain their
frontier as a separate stop condition; a null frontier permits observation but
no source advancement. The existing G44 `maximumSuid` stop and the certificate
closed-prefix stop remain independent gates. The runtime validates this
handoff; it does not acquire or mint G44/G62 proof.

Unmarked direct `catchUp` and `pollRegistered` calls discard all certificate
fields, including absent, null, or malformed values, and retain their ordinary
`maximumSuid`/SafeWindow behavior. They cannot acquire the new absence error.
SafeWindow, the fence clock, retries, drain behavior,
partial-write/unknown-outcome behavior, migrations, and allocator closure are
untouched by this repair.

The certificate type is a consumer-bound seam only. Issuance, reconciliation,
legacy membership proof, revocation, migration cuts, and certificate
acquisition cost belong to SDT-G77 and are deliberately not implemented here.

## Complete certificate-reachable call-site classification

The table covers every production caller found by source search for
`validatedClosedPrefixSuid`, `validatedSafeViewCoverageMaximumSuid`,
`requireClosedPrefixCertificate`, `safeViewCoverage`, and
`closedPrefixSuid`, plus adjacent callers that must remain outside the
boundary. “Safe-view advance” means the G75 certificate-controlled decision,
not whether an older ordinary SafeWindow or materialized-view operation may
still make progress under its existing contract.

| Call site | Advances a safe view? | Certificate/context behavior and reason |
| --- | --- | --- |
| `projection/LiveProjectionWorker.ts :: pollLiveProjections` safe-view branch, registered-projector mode | Yes | Validates the cached certificate and the actual-consumer-bound G44/G62 context, then delegates the marked decision to each registered `ProjectionRuntime.catchUp`. |
| `projection/LiveProjectionWorker.ts :: pollLiveProjections` safe-view branch, single-`tag` mode | Yes | Uses the same certificate, actual-service binding, and coverage/start-of-pass gate; the tag filter changes work selection, not authority. |
| `projection/ProjectionRuntime.ts :: catchUp` with `requireClosedPrefixCertificate: true` | Yes | Direct safe callers are revalidated against the actual `serviceId`, require the proven G44/G62 context, and retain both independent frontier gates before checkpoint advancement. |
| `projection/ProjectionRuntime.ts :: catchUp` without the certificate marker | No for the G75 certificate decision | Ignores certificate, prefix, expected-identity, and safe-context fields; diagnostics and ordinary/on-demand callers retain their prior behavior without `ordering_certificate_unavailable`. |
| `projection/ProjectionRuntime.ts :: pollRegistered` with the safe marker | Yes, through delegated `catchUp` jobs | Validates the actual consumer and context before listing jobs, then forwards the complete marked options to each safe catch-up. It cannot acquire authority. |
| `projection/ProjectionRuntime.ts :: pollRegistered` without the safe marker | No for the G75 certificate decision | Normalizes to the ordinary `maximumSuid` option only, so absent/null/malformed certificate fields cannot trigger a certificate failure. |
| `projection/LiveProjectionWorker.ts :: handleProjectionLag` (`poll=1`) | No for the G75 certificate decision | Calls direct `catchUp` without the marker; the diagnostic/on-demand probe remains ordinary and has no new certificate-absence failure. |
| `projection/ProjectionRuntime.ts :: catchUpDurableTagState` | No | Rebuilds from the authoritative Tag event list and does not mutate the SafeWindow checkpoint or consult certificate authority. |
| `mv/MaterializedViewCatchUp.ts :: build/follow/rebuild/followGeneration` | No | Has no certificate import, validator call, safe marker, or certificate-absence error; existing G44/SafeWindow semantics remain unchanged. |
| `src/index.ts :: createRuntimeWorker.scheduled` | No for the G75 certificate decision | Keeps the existing ordinary poll call shape; no certificate or safe context is acquired here. |
| `src/cloudflare.ts :: createCloudflareOnlyRuntimeWorker.scheduled` | No for the G75 certificate decision | Existing G44/G62 scanner and retained-frontier plumbing remains ordinary `maximumSuid` plumbing. This part does not add allocator acquisition or production certificate wiring. |
| `test/g75-certificate-scope.spec.ts` and the G75 guards | Proof only | Focused tests exercise marked and unmarked boundaries; they are not runtime certificate producers. |

An unlisted production caller would be a scope defect. In particular, the
materialized-view path has no `ClosedPrefixCertificate` or validator reference,
and the diagnostic path retains its direct ordinary `catchUp` call.

## Focused acceptance proof

`test/g75-certificate-scope.spec.ts` proves:

- direct unmarked `catchUp` and `pollRegistered` continue with absent, null,
  irrelevant, and malformed certificate fields;
- ordinary scheduled/diagnostic-style polling still does not validate a
  certificate;
- the marked safe decision fails closed for an absent certificate and for a
  missing G44/G62 coverage context;
- certificate identity, expected-service context, and coverage context are
  rejected when they identify a service other than the actual consumer;
- a proven `BLOCK/UNSETTLED` null frontier cannot advance a source checkpoint;
- explicit proven-FULL context permits an unbounded safe decision;
- a finite G44 `maximumSuid` still limits a certificate broader than it;
- a separate `SETTLED` G44/G62 context frontier still limits a certificate
  broader than it; and
- a certificate closed prefix still limits a safe decision when the G44/G62
  context and caller maximum are broader.

### AC3 mutant results

The focused product mutation runner executes both required behavioral mutants
against the real Vitest oracle. The finite-bound test for the first mutant uses
an explicit proven-FULL context so the G44 `maximumSuid` condition remains the
only authority for that bound; the second uses a broader G44/FULL bound so the
certificate condition remains the only limiting gate.

| Mutant | Mutation | Expected result |
| --- | --- | --- |
| `omit-g44-settled-frontier` | Removes the independent `maximumSuid` G44 stop condition while leaving the certificate and coverage gates | Red: the certificate-broader-than-G44 oracle advances past the settled frontier. |
| `omit-closed-prefix-certificate-gate` | Removes the validated closed-prefix stop condition while leaving the G44/FULL context | Red: the safe-view oracle advances past the certificate closed prefix. |

The source guard has matching self-tests, and the product runner restores the
source after each mutation. No guard is weakened and no timeout is changed.

## Local lane record

At W190 the focused `npm run test:g75:certificate-scope` lane passed: the
runtime package build, 10/10 focused tests, the source guard, and both
behavioral product mutants were green/red as expected. The runtime package
typecheck, changed-file ESLint, and `git diff --check` also passed.

The directly runnable affected-path regression set passed 5 files/15 tests
(`g58-safe-lane`, `g58-safe-lane-diagnosis`, `g58-reservation-reentry`,
`g58-live-poll-green-repair`, and `g58-live-poll-advancement-repair`). The
G44/G62 focused files passed 2 files/11 tests, and the G44 contract check
passed. The G62 guard self-test passed; its normal oracle could not start in
this worktree because that guard resolves a Vitest file at
`.g75-w188/node_modules/vitest/vitest.mjs`, which is not present. The aggregate
`npm run test:g58` command stopped before its tests in the unchanged
`build:packages` prelude on existing dcb-client/sample export drift. Neither
condition changed source behavior, and no bypass or test relaxation was added.

## Hosted terminal record

The repair was pushed to PR #155 at exact head
`3d4d2669186baada80f4af032ce658a18dcb6c1`, following starting head
`985d10e0c4f8d4606f4eb4a979a16c00d3c378c2`. Hosted CI run
`34344552925` completed successfully with all 21 jobs passing, including both
G30 lanes and the G75 lane in G44. Release preflight run `34344552824` also
completed successfully at the same head. No publish, tag, deployment, or
credential operation was performed.

## Scope and evidence boundary

This repair is limited to the F1/F2/F3 findings on PR #155: direct ordinary
compatibility, actual-consumer certificate/context binding, and the additional
G44/G62 coverage/start-of-pass gate. It does not begin SDT-G76 or SDT-G77 and
does not change allocator protocol, migration, recovery, commit outcome,
SafeWindow, fence clock, retries, package versions, deployment, publishing,
credentials, or unrelated CI.

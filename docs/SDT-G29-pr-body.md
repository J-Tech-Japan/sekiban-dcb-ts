# SDT-G29: rewrite sample and portability closure

Closes #64

This draft PR implements the SDT-G29 sample rewrite and portability closure.

## Delivered

- Rewrites `samples/meeting-room` on `@sekiban/dcb-domain` with typed,
  event-declared tags, discriminated state unions, per-event Validate/Evolve,
  typed Decider outcomes, and a real `toRuntimeDomain` bridge. The domain
  source has a CI-wired no-cast rule and exact `as` mutation probe.
- Preserves V1 behavior and mixed legacy/new replay through a committed
  pre-rewrite stored/outbox byte fixture, including legacy discriminator,
  G27 provenance, identity, tags, release noop, and the existing UI/runtime
  fixtures.
- Documents the C#⇄TS authoring correspondence with pinned
  `Sekiban@4fbd867` `EquipmentReservationCancelled` source and matching TS
  snippets; CI checks the anchors and content.
- Adds the per-view deliveryClass descriptor and executable 2×2×2 matrix
  through the real `MeetingRoomDownstreamDoorbell.deliver` and Queue wrapper,
  including the Room-only/Reservation-queued C3 regression.
- Keeps the mapping JSON as expectation authority while observations come
  from one shared fixture executed by real CommitWorker admission/storage, the
  DO-ts session, and the portable snapshot restore path. Admission evidence,
  DecisionLog bytes, claims, outcome, canonical identity, restored snapshot,
  event types, view manifest, and the runtime bridge are compared; observation
  code does not carry a parallel 13×7 expectation table.
- Pins the C# Validate/Evolve, ICommandWithHandler/ICommandContext, and
  EventOrNone source snippets at Sekiban@4fbd867 with matching TypeScript
  command/context/terminal snippets, and checks every exact source anchor.
- Executes the exact AC6 lanes old→old, old→new, new→new, new→old, and
  upgrade+downgrade replay through real V1/CommitWorker and
  toRuntimeDomain/CommitWorker adapter boundaries. Identity-bearing new→old
  is typed-rejected before downstream writes; both replay directions and the
  read-only downgrade use the committed bytes fixture. Residual discriminator
  plus widened post-G27 fallback is rejected before downstream store dispatch
  with zero calls.
- Adds six raw diagnostic fields with fresh/stale × version-match/mismatch
  fixtures using distinct expected/actual versions, exact raw field
  assertions, and per-quadrant mutation failures.
- Adds authenticated topology witness and fixed-N measurement tooling for the
  existing production identity. No reseed, fresh serviceId, destructive
  migration, or secret value is exposed by the deploy script. The final
  witnessed sequence redeploys the sealed candidate's receiver and primary
  Workers while keeping the receiver service-binding-only and the primary as
  the sole outbox Queue consumer.

## Verification

The oracle correspondence is in [docs/SDT-G29-oracle-map.md](./SDT-G29-oracle-map.md).
The mapping, delivery, compatibility, diagnostics, sample, typecheck, lint,
domain-source, pinned-authoring-document, and prior G13–G28 lanes are wired
into CI with forced-red reachability checks.

## Candidate protocol

This PR follows the non-self-referential `C''''`/`R''''` protocol. `C''''` is the
complete implementation/deployment/digest authority: it includes the receiver
production config; deploy, witness, measurement, topology, and evidence
scripts; the witness test; both candidate checkers; the required-roots manifest;
the oracle map; this PR body; and placeholder evidence. Every operational
material path is a runtime or configuration root in C''''; the placeholder
evidence is intentionally replaced by R'''' and therefore outside that immutable
digest. `R''''` may change only the final evidence document and append the
immutable C'''' SHA once to the retained-candidate list in `ci.yml`; no
operational recovery allowlist exists. The final live witness redeploys C''''
and records `deployedRuntimeCommit === sourceCommit === C''''`, primary Queue
consumer exclusivity, and pre-captured witness-set preservation. The candidate
checkers reject any other post-C path, an incomplete R, an inexact retained
append, accepted-existing deployment, `deploymentRequired:false`, a
deployed/source mismatch, or a digest mismatch.

## Witness evidence

The final evidence document is `docs/SDT-G29-deploy-evidence.json`. It records
the exact candidate, `deployedRuntimeCommit === sourceCommit`, raw pre/post
witness rows/heads/counts/lists, preserved worker/service/D1/DO/Queue identity,
and per-cycle command-start/response/visible timestamps with raw status beside
response→visible versus total latency distributions. The live deployment
script uses a protected file-backed conformance token (creating a temporary
rotation value when one is not supplied) as part of the final primary C
deployment. The pre-witness is public rows/heads/counts/lists plus raw-V1
closure, so it never needs the prior token or creates an intermediate
secret-only deployment. The post-witness must use G29 and report the sealed
candidate commit.

### F9 final-C reset

The previous C''' witness established the receiver-consumer and witness-set
semantics. F9 seals those materials into C'''' before deployment, so their
configuration, tests, scripts, manifest, and candidate gates are all digest
authority rather than a post-C exception. `docs/SDT-G29-deploy-evidence.json`
will carry the new C'''' raw pre/post witness and fixed-N=10 result; its
historical measurement fields remain explicitly separated into response→visible
and total latency, and secrets remain redacted.

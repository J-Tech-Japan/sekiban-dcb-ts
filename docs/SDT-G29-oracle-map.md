# SDT-G29 oracle map

This document is the implementation-side correspondence for issue #64. The
machine-readable mapping and delivery tables are the expectation authorities;
the tests consume those artifacts instead of maintaining a second hand-written
set of expected rows.

| AC | Contract | Executable oracle and evidence | Guard-isolation mutation |
| --- | --- | --- | --- |
| 1 | The meeting-room sample is authored on `@sekiban/dcb-domain`: event-declared tags, discriminated states, per-event Validate/Evolve, Decider outcomes, and no `as` cast in the domain source. | `samples/meeting-room/src/domain.ts`, `test/g29-meeting-room.spec.ts`, `test/meeting-room.spec.ts`, package typecheck/lint, and `scripts/g29-domain-source-check.mjs`. | The exact `room.of(roomId as string)` mutation is linted in a generated `src/domain.ts` probe and must be red. |
| 2 | Existing V1 bytes/semantics, mixed legacy/new replay, G27 identity, doorbell paths, newest-first UI, and release noop remain compatible. | `test/fixtures/g29-pre-rewrite-stored-outbox.json` is an immutable stored/outbox byte fixture; `test/g29-meeting-room.spec.ts` replays it through the real materializer and asserts byte identity, legacy discriminator, and G27 provenance. | Dropping the legacy payload discriminator or the canonical provenance is an independent exact replay failure before the final state assertion. |
| 3 | C# Decider constructs map to the TS authoring layer and both clocks remain separate. | `docs/domain-authoring.md` contains pinned `EquipmentReservationCancelled`, Validate/Evolve, ICommandWithHandler/ICommandContext, EventOrNone, and executable TS counterparts; `scripts/g29-authoring-doc-check.mjs` checks every exact anchor and source URL in CI. | Removing any pinned C# or matching TS anchor fails the documentation lane. |
| 4 | Domain per-view delivery descriptors are authoritative; global deployment settings only provide the descriptor-absent migration path. Effective direct set is the intersection of immediate views and the deployment allowlist; every other view is queued or has an explicit fail-fast/queued-degraded disposition. | `docs/SDT-G29-delivery-matrix.json` is an 8-row 2×2×2 table. `test/g29-delivery.spec.ts` drives `MeetingRoomDownstreamDoorbell.deliver` and the real Queue wrapper with direct/Queue spies, plus the Room-only/Reservation-queued C3 regression. | Removing `ReservationProjector` from the receiver's selected direct set is red because the separate Queue invocation is asserted. Descriptor-absent migration, global override, and degradation are separate exact outcomes. |
| 5 | The versioned three-runtime mapping table is the single expectation authority, including wire/owner/DO-ts/portable/version/unsupported columns. | `docs/SDT-G29-mapping.json` is the only expectation table. `test/g29-mapping.spec.ts` first executes a real `CommitWorker` admission/storage fixture (including the registered-version and caller-selected-version gates), then passes that evidence into one shared DO-ts and portable snapshot-wire execution; the observation is assembled from execution facts, DecisionLog/claims/outcome, restored snapshot, view manifest, event types, and runtime bridge. | All 13×7 row/column drops report the exact `rowId:columnId`; changing `registeredVersion ?? 1` to `?? 2` is red at the CommitWorker/admission boundary, and changing the artifact owner cannot change the observed execution. |
| 6 | The five compatibility lanes are exactly old→old, old→new, new→new, new→old, and upgrade+downgrade replay. | `test/g29-compatibility.spec.ts` executes old V1 through real CommitWorker adapter boundaries for old→old and old→new, an authored `toRuntimeDomain` command through `createRuntimeCommitPort` for new→new, the identity-bearing authored command through an old-runtime boundary for typed rejection/zero writes, and both replay directions plus read-only downgrade from the committed bytes fixture. | Canonical-to-raw admission, replay identity loss, fallback gate widening, or downstream dispatch mutation fails with typed rejection and zero-call attribution. |
| 7 | Freshness and version diagnostics expose six raw fields; the four quadrant values are derived only from those fields and V1 remains unchanged. | `samples/meeting-room/src/raw-diagnostics.ts` and `test/g29-diagnostics.spec.ts` contain fresh/stale × version-match/mismatch fixtures with distinct expected/actual versions, exact raw path/type/value assertions, all six field drops, and public-shape isolation. | Changing a match fixture's expected version to a mismatch value is red; merged `axis` and caller-supplied `quadrant` remain exact failures. |
| 8 | Production witness preserves the existing worker/service/D1/DO/Queue identity, uses a receiver that is service-binding-only while the primary exclusively owns the outbox Queue consumer, preserves every pre-captured row/head/list result as a post-captured subset, and measures fixed N≥10 response→visible separately from total. | `scripts/deploy/g29-deploy-witness.sh`, `samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc`, `scripts/deploy/g29-receiver-consumer-topology.mjs`, `scripts/deploy/g29-witness.mjs`, `scripts/deploy/g29-measure.mjs`, `scripts/deploy/g29-record-evidence.mjs`, authenticated `/conformance/v1/g29-config`, and the final evidence document. The deploy carries `G29_SOURCE_COMMIT`, rotates the conformance token from protected file input, records queue/worker consumer topology, and the candidate gate asserts `deployedRuntimeCommit === sourceCommit`; each cycle retains command-start/response/visible timestamps and raw status. | A receiver Queue consumer, a missing/changed pre-captured row/head/list entry, changed worker/source commit, serviceId, database, queue, generation, missing topology field, reordered phase, token exposure, or sample count below 10 fails before completion. Aggregate count equality is deliberately not a gate; final evidence names the fixed-N probe room/reservation writes that can advance it. |
| 9 | G13–G28 stay green; G29 lanes are CI-reachable with forced-red checks; required roots and non-self-referential C/R retention are enforced. | `.github/workflows/ci.yml`, `scripts/g29-candidate-check.mjs`, `docs/SDT-G29-required-roots.json`, package scripts, and the candidate evidence. | Mapping/delivery/diagnostic/compatibility/domain-source/authoring-doc/candidate switches must make their lane red; missing/empty required roots and post-C edits outside `{evidence, one retained-list append}` fail. |

### F3/F5/F6/F7 rereview closure

The AC3 correspondence checker now requires each pinned C# source and its
matching TypeScript source anchor: Validate/Evolve, ICommandWithHandler,
ICommandContext, and EventOrNone are all exact-content probes.

AC5 has one shared mapping input plus a real CommitWorker admission/storage
fixture. The admission evidence is fed into the same event's normal DO-ts
session and portable snapshot-wire restore, and the test compares DecisionLog
bytes, claims, terminal outcome, canonical event identity, view manifest, and
registered event types. The observation code has no parallel 13×7 expectation
table; docs/SDT-G29-mapping.json remains the only authority. Every row and
column is mutation-tested with a rowId:column attribution.

AC6 executes exactly old→old, old→new, new→new, new→old, and
upgrade+downgrade replay. The client/runtime lanes cross real V1 and
toRuntimeDomain/CommitWorker adapter boundaries. Identity-bearing new requests
go through the old-runtime typed rejection path; residual discriminator and
widened fallback inputs go through the real downstream adapter and fail closed
before its store is called.

AC7 uses four distinct raw fixtures: fresh/stale crossed with
version-match/version-mismatch. Match fixtures use expectedVersion 2 while
mismatch fixtures use different expected versions, and every raw field's
path/type/value is asserted before deriving the quadrant.

## Delivery matrix authority

The matrix rows are the complete product of domain class `{queued,
immediate-preferred}`, deployment `{enabled, disabled}`, and allowlist
`{allowed, not-allowed}`. The sample descriptor is:

```json
{"RoomProjector":"immediate-preferred","ReservationProjector":"immediate-preferred"}
```

The runtime derives `directInvocations` from the selected view set. A ready
sample requests invoke the direct port for both deployed views; queued-domain
rows invoke no direct port and queue both views; fail-fast rows invoke neither
port; queued-degraded rows (covered by the
focused test) queue both views and expose the exact degradation reason.

## Candidate C/R protocol

C''' remains the immutable deployed runtime/config/CI/docs/sample/test tree,
the required-root manifest, oracle map, PR body, and a placeholder evidence
document. The candidate checker computes sorted `sha256(path NUL content NUL)`
digests from `C` and requires `sourceCommit=C`. Under the SDT-G29-UNBLOCK-2
design ruling, bookkeeping may additionally change only the fixed
manifest-declared receiver-topology/witness recovery paths, the evidence
document, and append the immutable `C` SHA once to the retained candidate fetch
list in `ci.yml`; the checker requires that manifest list to equal the fixed
SDT-G29-UNBLOCK-2 list, so it cannot be expanded after C. Every other post-C
path remains rejected. The checker itself validates required-root removal and
empty-directory mutations, retained-list append cardinality, evidence
self-consistency, final deployment identity, and candidate tree digests.

## Witness order

The deploy script follows the normative order: checked-in config/bundle
preflight → remote migration read → pre-witness → checked-in additive
migrations → receiver deploy → primary deploy → post-witness/identity
comparison → fixed-N measurement. When an intentional policy transition is
part of the fix, the comparison supplies separate before/after topology
fixtures; worker/service/D1/Queue/DO identity, raw V1 closure, and data witness
remain strict while only the declared policy delta is admitted. It never
applies a destructive migration, reseeds data, creates a fresh service
identity, or emits a secret. The evidence reports command-start→response,
response→visible, and command-start→visible distributions independently.

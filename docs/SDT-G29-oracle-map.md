# SDT-G29 oracle map

This document is the implementation-side correspondence for issue #64. The
machine-readable mapping and delivery tables are the expectation authorities;
the tests consume those artifacts instead of maintaining a second hand-written
set of expected rows.

| AC | Contract | Executable oracle and evidence | Guard-isolation mutation |
| --- | --- | --- | --- |
| 1 | The meeting-room sample is authored on `@sekiban/dcb-domain`: event-declared tags, discriminated states, per-event Validate/Evolve, Decider outcomes, and no `as` cast in the domain source. | `samples/meeting-room/src/domain.ts`, `test/g29-meeting-room.spec.ts`, `test/meeting-room.spec.ts`, package typecheck/lint, and `scripts/g29-domain-source-check.mjs`. | The exact `room.of(roomId as string)` mutation is linted in a generated `src/domain.ts` probe and must be red. |
| 2 | Existing V1 bytes/semantics, mixed legacy/new replay, G27 identity, doorbell paths, newest-first UI, and release noop remain compatible. | `test/fixtures/g29-pre-rewrite-stored-outbox.json` is an immutable stored/outbox byte fixture; `test/g29-meeting-room.spec.ts` replays it through the real materializer and asserts byte identity, legacy discriminator, and G27 provenance. | Dropping the legacy payload discriminator or the canonical provenance is an independent exact replay failure before the final state assertion. |
| 3 | C# Decider constructs map to the TS authoring layer and both clocks remain separate. | `docs/domain-authoring.md` contains pinned `Sekiban@4fbd867` `EquipmentReservationCancelled` source and TS snippets; `scripts/g29-authoring-doc-check.mjs` checks URL, anchors, and content in CI. | Removing the pinned source anchor or a corresponding TS decider/projector anchor fails the documentation lane. |
| 4 | Domain per-view delivery descriptors are authoritative; global deployment settings only provide the descriptor-absent migration path. Effective direct set is the intersection of immediate views and the deployment allowlist; every other view is queued or has an explicit fail-fast/queued-degraded disposition. | `docs/SDT-G29-delivery-matrix.json` is an 8-row 2×2×2 table. `test/g29-delivery.spec.ts` drives `MeetingRoomDownstreamDoorbell.deliver` and the real Queue wrapper with direct/Queue spies, plus the Room-only/Reservation-queued C3 regression. | Removing `ReservationProjector` from the receiver's selected direct set is red because the separate Queue invocation is asserted. Descriptor-absent migration, global override, and degradation are separate exact outcomes. |
| 5 | The versioned three-runtime mapping table is the single expectation authority, including wire/owner/DO-ts/portable/version/unsupported columns. | `docs/SDT-G29-mapping.json` remains expectation-only. `samples/meeting-room/src/mapping-observation.ts` executes the authored command/session, serializes `DecisionLog`, derives real tags/reads/registry values, and `test/g29-mapping.spec.ts` also exercises the `composeRuntime` bridge. | Row×column drops compare the independent observation to the artifact and fail at the named `rowId:columnId`; changing the artifact owner cannot change the observed value. |
| 6 | Five compatibility lanes cover old/new clients and runtimes, old/new history replay, typed rejection where adaptation is impossible, and no identity-less post-G27 storage. | `test/g29-compatibility.spec.ts` invokes the actual `CommitWorker` admission/storage path with the registered version, inspects the Tag DO row, checks the old-runtime typed shim, and runs missing-identity through the downstream adapter. | Canonical-to-raw admission or post-G27 missing-identity dispatch mutations fail at the stored row/zero-call attribution. |
| 7 | Freshness and version diagnostics expose six raw fields; the four quadrant values are derived only from those fields and V1 remains unchanged. | `samples/meeting-room/src/raw-diagnostics.ts` and `test/g29-diagnostics.spec.ts` contain four independent source-before/after × checkpoint-behind/at-head fixtures, all six field drops, and public-shape isolation. | Each untested quadrant branch is individually covered; merged `axis` and caller-supplied `quadrant` remain exact failures. |
| 8 | Production redeploy preserves the existing worker/service/D1/DO/Queue identity and data, follows the witnessed order, and measures fixed N≥10 response→visible separately from total. | `scripts/deploy/g29-deploy-witness.sh`, `scripts/deploy/g29-witness.mjs`, `scripts/deploy/g29-measure.mjs`, authenticated `/conformance/v1/g29-config`, and the final evidence document. The deploy carries `G29_SOURCE_COMMIT`; compare asserts `deployedRuntimeCommit === sourceCommit`; each cycle retains command-start/response/visible timestamps and raw status. | A changed worker/source commit, serviceId, database, queue, generation, raw row/head/count/list, missing topology field, reordered phase, or sample count below 10 fails before completion. |
| 9 | G13–G28 stay green; G29 lanes are CI-reachable with forced-red checks; required roots and non-self-referential C/R retention are enforced. | `.github/workflows/ci.yml`, `scripts/g29-candidate-check.mjs`, `docs/SDT-G29-required-roots.json`, package scripts, and the candidate evidence. | Mapping/delivery/diagnostic/compatibility/domain-source/authoring-doc/candidate switches must make their lane red; missing/empty required roots and post-C edits outside `{evidence, one retained-list append}` fail. |

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

Candidate `C` contains the complete runtime/config/CI/docs/sample/test tree,
the required-root manifest, oracle map, PR body, and a placeholder evidence
document. The candidate checker computes sorted `sha256(path NUL content NUL)`
digests from `C` and requires `sourceCommit=C`. Bookkeeping `R` may update only
the evidence document and append the immutable `C` SHA once to the retained
candidate fetch list in `ci.yml`. Any other post-C change requires a new C and
full re-verification. The checker itself validates required-root removal and
empty-directory mutations, retained-list append cardinality, evidence
self-consistency, and candidate tree digests.

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

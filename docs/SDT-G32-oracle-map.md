# SDT-G32 oracle map

This map connects the public issue #68 acceptance criteria to executable
oracles. The G32 lanes are additive to the retained G13–G31 suite; any
intentional G13 surface delta is limited to 30-digit SUID values, UUID v7, and
serialized-path metadata values.

| AC | Contract | Executable oracle and isolated red proof | Evidence / authority |
| --- | --- | --- | --- |
| 1 | 19 tick digits + 11 crypto suffix, tick allocator, M1–M12 and every 30-digit ingress | `test/g32-parity.spec.ts`, `test/g32-suid-coverage.spec.ts`, `scripts/g32-suid-coverage.mjs`, and `fixtures/suid-allocator-golden.json` cover the exact required row set, BigInt-before-multiply, replay stability, atomicity, ceiling, rollback, SafeWindow, and all eight ingress gates. C2 additionally makes the real-Cosmos G22 bootstrap positive lane construct 30-digit/UUIDv7/unversioned G32 envelopes and retains old SUID/provenance/identity forms as typed zero-Cosmos-call negatives. The coverage script rejects a missing/extra row; each golden names the one-point mutant and exact result. | `packages/dcb-runtime/src/allocator/SortableUniqueId.ts`, `AllocatorDurableObject.ts`, `scripts/g22-bootstrap-cosmos-contract.mjs`, `docs/SDT-G29-mapping.json` |
| 2 | SafeWindow and ordering mapping use C# tick semantics, never the old 5s shortcut | The M8/M11/M12 parity cases assert 20s/120s bounds, tick comparisons, rollback warning, and business/event identity non-derivation. Existing G23/G31 safe-head/checkpoint/receipt/GC fixtures run unchanged against valid 30-digit fixtures. | `packages/dcb-runtime/src/safeWindow.ts`, `fixtures/suid-allocator-golden.json` |
| 3 | C# logical event record, DDL authority, sidecar, and new D1 baseline | `test/g32-ddl.spec.ts` introspects migrated D1 against `contracts/event-store-ddl.json`, rejects a UNIQUE SUID constraint, and permits a collision row for typed handling. `scripts/store-contract.mjs` verifies the Cosmos `/pk` header/document match, exact logical `ServiceId|Id` partition, and `IS_DEFINED(sortableUniqueId)` sidecar exclusion as well as Postgres/Cosmos layout and provider-managed field exclusion. | `contracts/event-store-ddl.json`, `migrations/d1/g32/0001_dcb_events.sql`, D1/Postgres/Cosmos stores |
| 4 | Payload is fatal-UTF-8/JSON/exact-case admitted and stored without reserialization | G32 parity writes whitespace/property-order-distinct JSON and reads identical text; commit/domain tests cover exact-case and camelCase gate failures before allocator/store/outbox calls. The C# runner separately consumes a byte-distinct semantic payload. | `CommitWorker.ts`, `event.ts`, `test/g32-parity.spec.ts`, `tools/sekiban-parity/run.mjs` |
| 5 | EventType is eventPayloadName; version option and legacy lane are retired | `test/g32-parity.spec.ts`, `test/g27-identity.spec.ts`, and `test/g29-compatibility.spec.ts` reject versioned/identity-less or stale queue records before dispatch. `scripts/g32-legacy-ingress-audit.mjs` classifies every remaining `eventPayloadVersion` reference, forbids it in executable positive fixtures, and makes an injected legacy provenance/version mutation red. G32 cutover tests reject bridge payloads and `name:version`; deployed witness requires an authenticated old bridge route 404. | `eventIdentity.ts`, `event.ts`, `compatibility.ts`, `scripts/g32-legacy-ingress-audit.mjs`, cutover evidence |
| 6 | UUID v7, C# serialized metadata, sidecar attempt facts, UTC Timestamp | G32 parity asserts UUID v7 allocation, fixed metadata, nullable C# import metadata, timestamp text, and sidecar persistence; provider contract fixtures cover v4 import without relaxing normal write admission. | `eventRecord.ts`, `dcb_event_ops`, `test/g32-parity.spec.ts` |
| 7 | Ordered tags and rebuildable `dcb_tags` | `test/g32-tags.spec.ts` calls the shipped tool for Postgres/SQLite/Cosmos output, verifies duplicate collapse, tag-group colon handling, deterministic sequence, and SUID-time Cosmos rows. | `contracts/dcb-tags-derivation.json`, `tools/derive-dcb-tags`, `docs/migration-sekiban-dcb.md` |
| 8 | Pinned C# runner proves C#→TS and TS→C# | `tools/sekiban-parity/run.mjs` clones/checks exactly `Sekiban@855feaa93564fef54defec76e9ccff969d4ee01a` before `dotnet run`; `Program.cs` verifies pinned source fragments and consumes both non-null and nullable records. The runner fails before use on pin drift and compares all manifest fields independently of hand-written row expectations. | `tools/sekiban-parity/SekibanParity.csproj`, `contracts/event-store-ddl.json` |
| 9 | B freeze, new service/D1/Queue final C, stale closure, fixed-N evidence | C1 used `scripts/g32-bridge-check.mjs`, `scripts/deploy/g32-bridge-witness.mjs`, `scripts/g32-cutover-check.mjs`, and `scripts/deploy/g32-deploy-cutover.sh` for the one-time new-binding cutover. C2 uses `scripts/deploy/g32-forward-redeploy.sh` only: public pre-witness set → retained receiver/primary redeploy with file-fed token rotation → preserved-set post-witness → primary-exclusive Queue check → N=10. Its script contains no migrate/apply/create/wipe/reseed path, and its witness rejects lost rows, changed details, or changed heads independently. | `docs/SDT-G32-bridge-evidence.json`, `docs/SDT-G32-cutover-evidence.json`, `contracts/g32-cutover.json` |
| 10 | G13–G31 regression, CI reachability, forced red, and non-self-referential C/R | CI runs `npm run test:g32` (including the C# runner, real-Cosmos fixture self-test, legacy-ingress audit, and forward-witness mutation fixtures), invokes its forced-red lane, and runs the candidate gate plus its forced-red lane. `scripts/g32-candidate-check.mjs` retains/verifies C1/R1, proves C2 material coverage and unchanged runtime digest, requires a forward-only preserved-data witness, and enforces R2's exact two-path/one-retained-SHA rule. | `.github/workflows/ci.yml`, `docs/SDT-G32-required-roots.json`, `docs/SDT-G32-pr-body.md` |

## Candidate protocol

B (`43029a8b8b0298b6cc30c531639d7398f6295805`) is sealed old-format
freeze-only code and has its own evidence. Final C contains every runtime,
configuration, CI, documentation, tooling, test, manifest, and placeholder
evidence change. Its tree digests are calculated from the root manifest at C;
the final deployment uses that exact C and exposes its source SHA/config
digest through authenticated conformance.

R1 recorded that completed C1 cutover. C2 is a separate one-time sealed
forward-fix candidate: it contains every stale-fixture correction, legacy
negative, audit, witness tool, documentation, manifest, and placeholder before
redeployment. C2 retains C1's serviceId/D1/Queue/DO namespace, does not rerun
bridge/freeze/wipe/new-resource provisioning, and its pre/post witness must
preserve the captured post-cutover data set. Its runtime/config digest is
compared to C1 and must remain unchanged for this CI/test-only correction.

The first prepared forward candidate
(`a8f98355bb6de0454725d34f0238cd12efd4519c`) was stopped by its local
read-only preflight before any Wrangler invocation because a shell interpolation
defect was detected. Its replacement records that no token rotation, remote
deploy, witness, or data operation occurred; the forward script test makes the
exact malformed interpolation red.

R2 is created only after the C2 forward witness. It changes
`docs/SDT-G32-cutover-evidence.json` and appends C2 once to the retained
candidate fetch list in `ci.yml`. The candidate gate rejects any other
post-C2 path, a digest mismatch, a missing C1/R1 history, a repeated cutover,
lost pre-witness data, or a retained SHA other than C2.

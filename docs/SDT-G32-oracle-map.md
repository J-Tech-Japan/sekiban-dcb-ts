# SDT-G32 oracle map

This map connects the public issue #68 acceptance criteria to executable
oracles. The G32 lanes are additive to the retained G13–G31 suite; any
intentional G13 surface delta is limited to 30-digit SUID values, UUID v7, and
serialized-path metadata values.

| AC | Contract | Executable oracle and isolated red proof | Evidence / authority |
| --- | --- | --- | --- |
| 1 | 19 tick digits + 11 crypto suffix, tick allocator, M1–M12 and every 30-digit ingress | `test/g32-suid-rows.spec.ts` gives M1–M12 one independent fixture each. `scripts/g32-suid-mutation-runner.mjs` applies each production mutation, rebuilds, proves the target row red and an unrelated row green; `scripts/g32-suid-coverage.mjs` rejects missing/extra, unexecutable/vacuous, and unrelated-row matrix gaps. M6/M9 install the real legacy-decision observer and prove raw 37-character values reached the retired decision before a typed reject. C2's G22 Cosmos positive lane remains 30-digit/UUIDv7/unversioned; old forms remain typed zero-downstream-call negatives. | `SortableUniqueId.ts`, `AllocatorDurableObject.ts`, `test/g32-suid-rows.spec.ts`, `scripts/g32-suid-mutation-runner.mjs` |
| 2 | SafeWindow and ordering mapping use C# tick semantics, never the old 5s shortcut | The M8/M11/M12 parity cases assert 20s/120s bounds, tick comparisons, rollback warning, and business/event identity non-derivation. Existing G23/G31 safe-head/checkpoint/receipt/GC fixtures run unchanged against valid 30-digit fixtures. | `packages/dcb-runtime/src/safeWindow.ts`, `fixtures/suid-allocator-golden.json` |
| 3 | C# logical event record, DDL authority, sidecar, and new D1 baseline | `test/g32-ddl.spec.ts` keeps D1 `PRAGMA`/`sqlite_master` introspection. `scripts/g32-ddl-introspection.mjs` independently reads real Postgres `information_schema` + `pg_catalog`, classifies every Cosmos field as manifest application or provider-managed, and makes snake-case, `jsonb`, nullability, index name/order, unknown/drop application field, and logical `_etag` mutations red. `scripts/store-contract.mjs` reads the same DDL authority only in its standalone Node entry point; `test/d1-pipeline.spec.ts` imports its shared pipeline contract inside a real Miniflare Worker and proves that no host-filesystem load occurs there. | `contracts/event-store-ddl.json`, `scripts/g32-ddl-introspection.mjs`, `scripts/store-contract.mjs`, `migrations/d1/g32/0001_dcb_events.sql` |
| 4 | Payload is fatal-UTF-8/JSON/exact-case admitted and stored without reserialization | `test/g32-payload-admission.spec.ts` invokes public `CommitWorker.handle` for non-UTF-8, JSON syntax, root, nested, array-object, additional-member, and case-only duplicate-key rejections independently; each asserts allocator/journal/tag zero calls. Its success case captures the actual admission payload to prove no parse/reserialize. `scripts/g32-payload-admission-mutation-runner.mjs` applies fatal-decoder, parser, each exact-member gate, and reserialization mutants and requires target-red/unrelated-green. | `CommitWorker.ts`, `test/g32-payload-admission.spec.ts`, `scripts/g32-payload-admission-mutation-runner.mjs` |
| 5 | EventType is eventPayloadName; version option and legacy lane are retired | `test/g32-parity.spec.ts`, `test/g27-identity.spec.ts`, and `test/g29-compatibility.spec.ts` reject versioned/identity-less or stale queue records before dispatch. `scripts/g32-legacy-ingress-audit.mjs` classifies every remaining `eventPayloadVersion` reference, forbids it in executable positive fixtures, and makes an injected legacy provenance/version mutation red. G32 cutover tests reject bridge payloads and `name:version`; deployed witness requires an authenticated old bridge route 404. | `eventIdentity.ts`, `event.ts`, `compatibility.ts`, `scripts/g32-legacy-ingress-audit.mjs`, cutover evidence |
| 6 | UUID v7, C# serialized metadata, sidecar attempt facts, UTC Timestamp | G32 parity asserts UUID v7 allocation, fixed metadata, nullable C# import metadata, timestamp text, and sidecar persistence. C3 adds a real D1 import of C#'s 1–7 fractional-digit UTC output (including six fractional digits), so variable C# `DateTime` formatting is accepted without changing payload bytes. | `eventRecord.ts`, `dcb_event_ops`, `test/g32-parity.spec.ts` |
| 7 | Ordered tags and rebuildable `dcb_tags` | `test/g32-tags.spec.ts` calls the shipped tool and compares every PostgreSQL and Cosmos field to manifest-derived expected rows. `scripts/g32-tags-mutation-runner.mjs` applies `pk` and `id` replacement mutants to the production tool and proves provider-target red/unrelated-provider green. | `contracts/dcb-tags-derivation.json`, `tools/derive-dcb-tags`, `scripts/g32-tags-mutation-runner.mjs` |
| 8 | Pinned C# runner proves C#→TS and TS→C# | `tools/sekiban-parity/run.mjs` checks exactly `Sekiban@855feaa93564fef54defec76e9ccff969d4ee01a`, builds the actual linked Sekiban projects outside the transport, then runs `produce`/both consume directions with `--no-build`. Thus compiler warnings cannot share stdout with the one parseable C#→TS artifact. `test/g32-parity-runner.spec.ts` makes removal of that build/transport separation red, and the runner executes the actual path. `test/g32-csharp-runtime.spec.ts` sends C# provider records through real D1 import/replay/public list-query and captures an actual TS Cosmos provider row before C# consumes it. Expectations derive solely from the DDL manifest. | `tools/sekiban-parity/SekibanParity.csproj`, `Program.cs`, `run.mjs`, `test/g32-parity-runner.spec.ts`, `test/g32-csharp-runtime.spec.ts`, `contracts/event-store-ddl.json` |
| 9 | B freeze, new service/D1/Queue final C, stale closure, fixed-N evidence | C1 used the bridge/cutover scripts for the one-time new-binding cutover. C2/C3/C4/C5 retain those bindings. C5 uses only `scripts/deploy/g32-forward-redeploy.sh`: public pre-witness set → retained receiver/primary redeploy with file-fed token rotation → preserved-set post-witness → primary-exclusive Queue check → N=10. It contains no migrate/apply/create/wipe/reseed path; its permanent read-only migration preflight uses the `D1`/`D1_MV` config bindings required by Wrangler 4.125.0, and its witness rejects lost rows, changed details, or changed heads independently. | `docs/SDT-G32-bridge-evidence.json`, `docs/SDT-G32-cutover-evidence.json`, `contracts/g32-cutover.json` |
| 10 | G13–G31 regression, CI reachability, forced red, and non-self-referential C/R | CI runs `npm run test:g32` including every C3 production mutation runner, Postgres/Cosmos introspection, real-Cosmos negative lane, legacy audit, the C# provider runner, the Worker-safe C4 import path, and C5's single-JSON stdout transport. Forced-red and candidate forced-red lanes remain separate. `scripts/g32-candidate-check.mjs` preserves C1/R1 through C4/R4, requires C5 material coverage, requires C5 runtime/deployment bytes to equal C4 while configuration changes, records the stdout-isolation attribution, and enforces R5's exact two-path/one-retained-SHA rule. | `.github/workflows/ci.yml`, `docs/SDT-G32-required-roots.json`, `docs/SDT-G32-pr-body.md` |

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

R2 was created only after the C2 forward witness. It changes
`docs/SDT-G32-cutover-evidence.json` and appends C2 once to the retained
candidate fetch list in `ci.yml`. The candidate gate rejects any other
post-C2 path, a digest mismatch, a missing C1/R1 history, a repeated cutover,
lost pre-witness data, or a retained SHA other than C2.

C3 is the single seal for the F1–F5 correction set: all production mutation
runners, DDL/provider introspection, actual C# runtime/provider runner, the
C# 1–7 fractional UTC ingress fix, C3 deployment/evidence tooling, updated
manifest, documentation, and the C3 placeholder are material before sealing.
Unlike C2, C3 contains runtime changes, so its runtime and deployment/config
digests must differ from C2. It performs exactly one forward-only retained
binding redeploy and set-preservation/N=10 witness. R3 then changes only the
evidence JSON and appends C3 once to CI retained history.

C4 is required because CI exposed a deterministic post-C3 test-runner import
boundary: a Miniflare D1 Worker cannot read the host checkout through Node's
filesystem facade. C4 defers that read to the standalone Node runner while
retaining the real D1 Worker contract. C4 is a new sealed candidate rather
than an amendment to deployed C3. Its runtime and deployment-config digests
must equal C3, its configuration digest must differ, and it performs the same
single forward-only set-preservation/N=10 witness. R4 is again restricted to
the evidence JSON and exactly one retained-C4 CI append.

C5 is required because the first C4 CI run then exposed a second, independent
runner boundary: a compiler warning from the pinned real Sekiban build was
written to stdout before the C# `produce` JSON artifact. C5 builds once outside
that transport and runs every actual C# produce/consume operation with
`--no-build`, preserving the real serialization and provider paths while
requiring exactly one parseable stdout artifact. C5 has C4-identical runtime
and deployment-config digests, a changed configuration digest, and one
forward-only preservation/N=10 witness. R5 is restricted to evidence plus one
retained-C5 CI append.

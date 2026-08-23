# SDT-G32 — Sekiban.Dcb record parity and wipe cutover

Closes #68

## What changes

- Switches `SortableUniqueId` to the C# 30-digit format: 19 .NET ticks plus
  11 allocator-owned crypto digits, with a one-authority tick allocator and
  independent M1–M12 goldens.
- Stores the C# logical `dcb_events` record across D1, Postgres, and Cosmos;
  TS-only operational facts move to `dcb_event_ops`.
- Preserves decoded UTF-8 JSON payload bytes, rejects malformed/case-mismatched
  payloads before durable work, removes the `event()` version option, makes
  EventType equal the payload name, uses UUID v7 and C# serialized metadata.
- Ships `derive-dcb-tags` and a pinned C# bidirectional parity runner for
  `Sekiban@855feaa93564fef54defec76e9ccff969d4ee01a`.
- Completes the one-time bridge-B → final-C production cutover to a new
  serviceId, pipeline/MV D1 databases, and Queue. Old sample data is wiped by
  specification and is never read or translated.

## Verification

`npm run test:g32` runs the focused parity/DDL/tag/cutover lane, allocator
coverage gate, bridge and final-cutover static checks, Queue topology self-test,
the G22 real-Cosmos G32-envelope self-test, the exhaustive legacy-ingress
audit, forward-witness data-preservation mutations, and both directions of the
C# runner. CI also runs a forced-red proof for the lane and the
non-self-referential candidate protocol gate.

The full retained G13–G31 suite runs in CI. The G13 wire delta is limited to
the intentional 30-digit SUID value format, UUID v7 event ID, and C# metadata
values; endpoint shape, status, Content-Type, JSON keys, and all other bytes
remain guarded by the existing G13 fixtures.

## Cutover protocol and evidence

- Bridge B: `43029a8b8b0298b6cc30c531639d7398f6295805`, deployed as old-format
  freeze-only code with all seven writer entrypoints acknowledged. Its evidence
  is `docs/SDT-G32-bridge-evidence.json`.
- Final C: one sealed commit containing all runtime/config/CI/docs/tools/tests
  and a placeholder cutover evidence file. It is both the deployed source and
  digest authority.
- R: after the witnessed deployment only, replaces the placeholder with
  pre/post witness, fresh D1 baseline, Queue topology, raw V1/bridge closure,
  30-digit stale negative, and raw N=10 response/list samples; it also appends
  C exactly once to CI retained history.

The cutover evidence explicitly marks data preservation **not applicable**:
the incompatibility of prefixed legacy SUID sort order requires the approved
full wipe/new service identity. After the first application write to fresh D1,
corrections are forward-only.

## C2 forward fix after C1 cutover

C1 (`9bf654eb555e56a2b0d5ed9f04d0aad670866e9e`) and its evidence R1 remain
historical cutover evidence. C2 corrects a stale G22 real-Cosmos CI fixture:
its positive bootstrap rows now use a 30-digit SUID, UUIDv7, unversioned
EventType equal to the payload name, and the fixed internal G32 provenance.
The obsolete prefixed-SUID, legacy-provenance, and identity-less forms remain
as explicit typed-reject/zero-Cosmos-call negatives.

C2 is a single sealed forward-only candidate. It retains the already-created
G32 serviceId, D1 IDs, Queue, worker names, and Durable Object namespaces; it
does not rerun bridge/freeze/wipe/new-resource provisioning. The C2 deploy
captures a public pre-witness data set, rotates conformance/fence credentials
through files during retained receiver/primary deployment, proves pre/post set
preservation, rechecks all deployed 30-digit gates, and records fresh N=10
raw timestamps. The original wipe exception applies only to C1; C2 requires
preservation of existing G32 data.

The first prepared C2 commit (a8f98355bb6de0454725d34f0238cd12efd4519c)
was rejected during its local read-only preflight because its shell variable
interpolation was malformed. No Wrangler command, token rotation, deployment,
or data witness began. The corrected replacement candidate retains that
rejected-preflight record and is sealed before the one permitted forward
redeploy.

After C2, R2 is restricted to the updated evidence document and one C2 SHA
append in the CI retained-candidate list. The candidate gate also records that
the runtime/config digest is unchanged because this fix is fixture/test/CI
material only.

## C3 review repair: F1–F5 attribution and actual provider paths

C3 is sealed only after the complete F1–F5 repair set is present: independent
M1–M12 fixtures plus production mutation/unrelated-row execution; live
Postgres/Cosmos DDL introspection; public CommitWorker payload-admission
zero-call/mutation fixtures; full provider tag-field comparisons; and a pinned
C# runner using actual Sekiban serialization and provider models against real
TS D1 import/replay/list-query and Cosmos provider rows. During that work the
real C# path exposed a runtime defect: C# UTC `DateTime` values may trim to
1–7 fractional digits, so G32 now accepts those exact UTC values without
payload reserialization.

C3 is forward-only on C2's existing serviceId/D1/Queue/DO identities; it does
not rerun bridge/freeze/wipe/new-resource provisioning. It must have changed
runtime and deployment/config digests relative to C2, then execute one
preservation witness, all 30-digit ingress checks, and fresh N=10. R3 is
limited to the evidence document plus one retained-C3 CI append.

## C4 CI-boundary repair after C3 witness

C3/R3 exposed a deterministic CI defect after its deployed witness: the real
Miniflare D1 Worker imports the shared `runPipelineContract`, but the module
eagerly read the host checkout's DDL manifest through Node filesystem APIs.
That filesystem facade is intentionally unavailable inside the Worker. C4
defers the manifest read to the standalone Node Postgres/Cosmos runner, while
the real Worker import continues to exercise the D1 provider without a host
filesystem dependency.

C4 is a new sealed forward-only candidate, not an amendment of deployed C3.
It retains the serviceId, D1 IDs, Queue, worker names, and Durable Object
namespaces; it does not repeat bridge/freeze/wipe/new-resource provisioning.
Because the change is test/runner-only, C4 must prove its runtime and
deployment-config digests are byte-identical to C3 while its configuration
digest changes. The deployment script permanently uses `D1` and `D1_MV` config
binding names for Wrangler 4.125.0's read-only migration-list preflight.
C4 then records the same preservation witness, 30-digit ingress check, and
fresh N=10. R4 is limited to evidence plus one retained-C4 CI append.

## C5 C# JSON-transport repair after C4 witness

The first C4 CI run proved all F1–F4 oracles and the real C# provider path,
then exposed an independent C# runner defect: a warning from the pinned
Sekiban project build was written to stdout ahead of the machine-readable
`produce` artifact. C5 builds the linked real Sekiban projects once outside
the JSON transport and invokes `produce`, `consume-postgres`, and
`consume-cosmos` with `dotnet run --no-build`. The runner therefore still uses
the actual serializer and provider models while exposing exactly one parseable
C#→TS artifact.

C5 is a new sealed forward-only candidate, not an amendment of deployed C4.
It retains the same serviceId, D1 IDs, Queue, worker names, and Durable Object
namespaces; it does not repeat bridge/freeze/wipe/new-resource provisioning.
Its runtime and deployment-config digests must be byte-identical to C4 while
its configuration digest changes. It records a new preservation witness,
all-30-digit ingress check, and fresh N=10. R5 is limited to the evidence
document plus one retained-C5 CI append.

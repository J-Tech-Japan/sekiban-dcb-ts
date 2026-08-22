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
and both directions of the C# runner. CI also runs a forced-red proof for the
lane and the non-self-referential candidate protocol gate.

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

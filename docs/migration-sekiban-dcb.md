# Sekiban.Dcb logical-event migration guide

SDT-G32 makes the TypeScript runtime's stored event shape interoperable with
Sekiban.Dcb. This guide covers offline export/import and rebuild work; it does
not authorize a mixed old/new production service. Old `suid-` values sort after
the new 30-digit form, so the meeting-room production change is a full wipe
with a new serviceId, D1 databases, and Queue.

## Logical record

An event is the C# logical record:

```json
{
  "serviceId": "service",
  "id": "018f9c51-6b74-7f5e-8ca1-0123456789ab",
  "sortableUniqueId": "063923011636102000000000000001",
  "eventType": "RoomReserved",
  "payload": "{\"roomId\":\"room-1\"}",
  "tags": ["room:room-1"],
  "timestamp": "2026-08-22T17:00:00.1230000Z",
  "causationId": "018f9c51-6b74-7f5e-8ca1-0123456789ab",
  "correlationId": "SerializedCommit",
  "executedUser": "SerializedSekibanExecutor"
}
```

`sortableUniqueId` is exactly 30 ASCII digits: 19 .NET ticks plus an
allocator-owned 11-digit suffix. `eventType` is the payload type name, not
`name:version`; payload revisions use a different payload name. `payload` is a
JSON text value whose UTF-8 bytes, whitespace, property order, and numeric
spelling are preserved. Tags are ordered `family:value` strings. TypeScript
operational arrival facts, lineage, and commit attemptId belong in
`dcb_event_ops`, not this record.

## TypeScript to C#

1. Stop the source writer and export `dcb_events` logical records, retaining
   the exact `payload` text and tag order.
2. Import the records into C# `dcb_events`. Validate UUID/SUID/EventType and
   all ten logical fields before writing.
3. Run `tools/derive-dcb-tags --provider postgres` (or `sqlite`/`cosmos`) over
   the exported records. It sorts by `(sortableUniqueId, tag)`, collapses a
   duplicate tag within an event, and emits C# rebuild rows.
4. Check derived row count and field content, then perform the C# tag query.

The repository's pinned `tools/sekiban-parity` runner exercises the same
record path in CI, including byte-distinct payload JSON and nullable C# import
metadata.

## C# to TypeScript

1. Stop the C# writer and export `dcb_events`; `dcb_tags` is intentionally not
   imported as runtime authority.
2. Import/replay logical events through the TypeScript bootstrap import lane.
   It accepts C# RFC 4122 IDs and all-null C# metadata where appropriate, but
   validates 30-digit SUIDs, unversioned EventType, exact payload casing, and
   tag strings before any durable write.
3. Rebuild Tag Durable Object state and projections from events. The event
   tags and Tag DO remain authoritative; no runtime tags table is maintained.
4. Use the projection/list query only after the normal replay/convergence
   receipt confirms the imported target.

## Production cutover safety

The sample's documented bridge/final protocol is intentionally stricter than
an offline migration: bridge B freezes every old-format writer, final C binds a
new serviceId, D1 pipeline/MV databases, and Queue, then enables only the
fresh 30-digit ingress. It records the old-store inventory as a wipe allowlist
and explicitly marks data preservation **not applicable**. No legacy reader,
SUID translation, payload sniffing, or old Queue replay is permitted.

Before the first final-store command the operation may abort after the
pre-witness; once that first command writes a fresh logical event, corrections
are forward-only. The final evidence records source/deployed C identity, the
new binding IDs, raw 5-endpoint conformance, raw V1 404, old-SUID rejection,
and ten command-to-single-list-redraw samples.

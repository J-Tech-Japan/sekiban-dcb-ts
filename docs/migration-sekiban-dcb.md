# Sekiban.Dcb logical-event migration guide

The Sekiban compatibility migration makes the TypeScript runtime's stored event shape interoperable with
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

1. Stop all writers and export the exact logical records, retaining payload
   text and tag order.
2. Import the records into C# `dcb_events` and validate all ten logical fields.
3. Obtain an already sealed global file containing committed membership and
   healthy coverage. This repository has no producer for that file. Stop when
   either committed membership or healthy sealed evidence is unavailable.
4. Load the matching logical events into a fresh PostgreSQL service target.
   Run the read-only dry run first:

   `npm run postgres:tags:rebuild -- --input <sealed.json>`

   Review the file digest, content digest, counts, and exact proposed rows.
   Apply only after review:

   `npm run postgres:tags:rebuild -- --input <sealed.json> --apply --input-sha256 sha256:<64 lowercase hex> --receipt <receipt.json>`

   An additive membership requires an explicit correction file and its exact
   supplied digest:

   `npm run postgres:tags:rebuild -- --input <sealed.json> --apply --input-sha256 sha256:<64 lowercase hex> --receipt <receipt.json> --correction-manifest <correction.json> --correction-sha256 sha256:<64 lowercase hex>`

   Retain the receipt. An exact rerun recovers the stored receipt after a file
   failure and performs no inserts. Rebuilt tag-summary `FirstEventAt` and
   `LastEventAt` values are the rebuild transaction time because every rebuilt
   `CreatedAt` uses that time. SQLite and experimental Cosmos live rebuilds are not
   supported here.

The repository's pinned `tools/sekiban-parity` runner exercises the same
record path in CI, including byte-distinct payload JSON and nullable C# import
metadata.

## C# to TypeScript

1. Stop all writers and export the exact logical records.
2. Import the records into a fresh TypeScript service target.
3. This repository has no C#→TypeScript live tag-state rebuild path. Do not
   construct committed membership from declared tags, bootstrap counts, or an
   events-only file. Stop when committed membership or healthy sealed evidence
   is unavailable.
4. Recreate or verify TypeScript tag state through the application's supported
   import and projection procedures. The PostgreSQL rebuild command documented
   above is the PostgreSQL-only TypeScript→C# procedure; it does not populate Durable
   Object tag storage. SQLite and experimental Cosmos live rebuilds are not supported here.

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

The **not applicable** preservation exception applies only to that completed
one-time cutover. A later forward-only redeploy of the new service must
capture a pre-deploy witness set and prove that every captured row, head, and
list entry remains present and semantically unchanged after deployment. It
must retain the existing serviceId/D1/Queue/DO namespace and must not repeat
the bridge, freeze, wipe, or new-resource provisioning steps.

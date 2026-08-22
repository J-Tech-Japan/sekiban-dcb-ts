# Meeting-room domain authoring: C# ⇄ TypeScript

SDT-G29 uses the same domain boundary in the C# and TypeScript examples: an
event declares its schema and tags, a projector owns one tag family and a
discriminated state, and a command declares its read set before it can append.
The TypeScript sample is the executable reference for the wire-compatible
meeting-room example.

The design decision is recorded in
[ADR-0001 — domain authoring and decider](https://github.com/J-Tech-Japan/SekibanDcbTsHost/blob/main/intents/sekiban-dcb-ts/design/adr-0001-domain-authoring-decider.md)
and the source means in
[means/15-domain-authoring](https://github.com/J-Tech-Japan/SekibanDcbTsHost/blob/main/intents/sekiban-dcb-ts/intent-tree/means/15-domain-authoring.md).

| Concern | C# authoring shape | TypeScript authoring shape | Portability rule |
| --- | --- | --- | --- |
| Event | `Event<TPayload>` / event definition | `event("RoomCreated", z.object(...), { tags })` | The registered definition assigns `RoomCreated:1`; the caller cannot choose a version. |
| Tags | `Tag<Room>` / `Tag<Reservation>` | `tagFamily("room").of(roomId)` | Tags are derived from the parsed payload once and are preserved through V1, stored, Queue, and projection hops. |
| State | `State<T>` with a closed discriminator | `stateUnion(z.discriminatedUnion("status", ...))` | Projector state remains JSON and is validated on every evolution. |
| Projector | `Projector<TState, TTag>` | `projector({ id, tag, events, state, handlers })` | A projector subscribes only to its registered event identities and tag family. |
| Validate | decider validation function | `validate((state, input) => ...)` | Validation can return a typed reject before an append. |
| Evolve | pure event-to-state function | `evolve((state, event) => ...)` | Evolve has no clock, network, allocator, or side effect. |
| Command | `Decide` / declared read set | `command({ input, reads, handle })` | `read(...)` and `readSet(...)` are the complete snapshot authority for a session. |
| Terminal result | committed, no-op, rejected | `done(...)`, `none(...)`, `reject(...)` | The bridge maps these to the existing `committed|noop|rejected` runtime contract. |
| Runtime bridge | host runtime adapter | `toRuntimeDomain(authoredDomain)` | The bridge is structural; the five V1 endpoint bytes are unchanged. |

## Meeting-room example

The TypeScript sample defines `RoomCreated`, `RoomReserved`,
`ReservationCancelled`, and `RoomReleased`. `RoomReserved` derives both the
room and reservation tags from one validated payload. `reserve-room` declares
both projector cells, reads both before deciding, and appends one event. A
legacy `eventType` property in an old stored payload is ignored by the schema
parser; a new payload does not manufacture that property.

The HTTP command adapter reads the remote V1 tag-state rows into a portable
snapshot, runs the authored command through `executeCommand`, and translates
the candidate to the existing V1 commit spelling. Allocator `eventId` and
SUID values are assigned only after admission; they are not part of the
authoring decision or `DecisionLog`.

## The two-clock rule

Business time and ordering time are separate:

1. A command captures one `context.now()` value before its retry loop. That
   value may be used as business time and must remain unchanged on a conflict
   retry.
2. The allocator `OrderClock` is the only source of SUID order. It converts
   Unix milliseconds to a fixed-width ordinal and applies
   `max(tick, watermark + 1)` in its write transaction.

No command, event payload, tag deriver, or projector may use the allocator
clock as business time, and no client may supply an event version, eventId, or
SUID. The mapping and compatibility fixtures exercise these ownership
boundaries directly.

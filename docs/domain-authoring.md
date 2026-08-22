# Meeting-room domain authoring: C# ⇄ TypeScript

SDT-G29 uses the same domain boundary in the C# and TypeScript examples: an
event declares its schema and tags, a projector owns one tag family and a
discriminated state, and a command declares its read set before it can append.
Under SDT-G32, the registered event payload name is also the durable C#
`EventType`; authors never select a version at a call site.
The TypeScript sample is the executable reference for the wire-compatible
meeting-room example.

The design decision is recorded in
[ADR-0001 — domain authoring and decider](https://github.com/J-Tech-Japan/SekibanDcbTsHost/blob/main/intents/sekiban-dcb-ts/design/adr-0001-domain-authoring-decider.md)
and the source means in
[means/15-domain-authoring](https://github.com/J-Tech-Japan/SekibanDcbTsHost/blob/main/intents/sekiban-dcb-ts/intent-tree/means/15-domain-authoring.md).

The C# side below is pinned to the checked-in template at
[`Sekiban@4fbd867`](https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/templates/Sekiban.Dcb.Templates/content/Sekiban.Dcb.Orleans.Decider/SekibanDcbDecider.MeetingRoomModels/Events/EquipmentReservation/EquipmentReservationCancelled.cs).
The snippets are copied from that source, rather than from a generic API
description. `scripts/g29-authoring-doc-check.mjs` checks the pin, anchors, and
the corresponding TypeScript source in CI.

## Pinned event correspondence

| C# template (`EquipmentReservationCancelled.cs`) | TypeScript sample (`samples/meeting-room/src/domain.ts`) |
| --- | --- |
| ```csharp
using Dcb.MeetingRoomModels.Tags;
using Sekiban.Dcb.Events;
namespace Dcb.MeetingRoomModels.Events.EquipmentReservation;

public record EquipmentReservationCancelled(
    Guid EquipmentReservationId,
    string Reason,
    DateTime CancelledAt) : IEventPayload
{
    public EventPayloadWithTags GetEventWithTags() =>
        new(this, new EquipmentReservationTag(EquipmentReservationId));
}
``` | ```ts
const reservationCancelled = event("ReservationCancelled", z.object({
  reservationId: z.string().min(1),
  roomId: z.string().min(1).optional(),
}), {
  tags: (payload) => [reservation.of(payload.reservationId)],
});
``` |

The C# record's payload, event implementation, and `GetEventWithTags()` are
the pinned anchors. The TS `event(...)` schema and tag deriver are the same
three responsibilities: validate the payload, register the event identity,
and derive the tag from the parsed payload. The example uses different
business names because the repository sample models a room reservation rather
than equipment inventory; the shape and ownership correspondence is what is
portable.

## Pinned decider and command contracts

The following snippets are also copied from `Sekiban@4fbd867`; they are kept
as source-pinned correspondence points rather than paraphrased API prose.
The URLs deliberately point at the exact reviewed commit.

### Validate / Evolve

[`EquipmentReservationCancelledDecider.cs`](https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/templates/Sekiban.Dcb.Templates/content/Sekiban.Dcb.Orleans.Decider/SekibanDcbDecider.MeetingRoomModels/States/EquipmentReservation/Deciders/EquipmentReservationCancelledDecider.cs):

```csharp
public static void Validate(this EquipmentReservationState.EquipmentReservationCheckedOut state)
{
    throw new InvalidOperationException("Cannot cancel reservation with checked out equipment. Return items first.");
}

public static EquipmentReservationState Evolve(this EquipmentReservationState state, EquipmentReservationCancelled cancelled) =>
    state switch
    {
        EquipmentReservationState.EquipmentReservationPending => new EquipmentReservationState.EquipmentReservationCancelled(
            cancelled.EquipmentReservationId,
            cancelled.Reason,
            cancelled.CancelledAt),
        EquipmentReservationState.EquipmentReservationAssigned => new EquipmentReservationState.EquipmentReservationCancelled(
            cancelled.EquipmentReservationId,
            cancelled.Reason,
            cancelled.CancelledAt),
        _ => state // Idempotency: cannot cancel if checked out, returned, or already cancelled
    };
```

The corresponding TS functions are the executable sample's validation and
pure evolution hooks:

```ts
export const validateCancelReservation = validate<ReservationState, ReservationOnlyInput, RejectKind>((state) =>
  state.status === "empty"
    ? validationReject("not-found", "reservation does not exist", "reservation_missing")
    : undefined);

export const evolveReservationCancelled = evolve<ReservationState, typeof reservationCancelled>((state) => {
  if (state.status === "empty") return state;
  return { status: "cancelled", version: state.version + 1, reservationId: state.reservationId, roomId: state.roomId };
});
```

### ICommandWithHandler / ICommandContext

The command interfaces are pinned to the WithResult model:

[`ICommandWithHandler.cs`](https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/dcb/src/Sekiban.Dcb.WithResult.Model/Commands/ICommandWithHandler.cs)

```csharp
public interface ICommandWithHandler<TSelf> : ICommand, ICommandHandler<TSelf> where TSelf : ICommandWithHandler<TSelf>
{
}
```

[`ICommandContext.cs`](https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/dcb/src/Sekiban.Dcb.WithResult.Model/Commands/ICommandContext.cs)

```csharp
public interface ICommandContext : ICoreCommandContext
{
}
```

The TS command definition makes the same handler/context boundary explicit;
the inferred context is used only through declared reads, state, and append:

```ts
export const cancelReservationCommand = command({
  id: "cancel-reservation",
  input: reservationOnlyInput,
  reads: (input) => read(reservationProjector, reservationTag(input.reservationId)),
  handle: async (input, context) => {
    const state = await context.state(reservationProjector, reservationTag(input.reservationId));
    const invalid = validationDecision(validateCancelReservation(state, input));
    if (invalid !== undefined) return invalid;
    context.append(reservationCancelled, reservationCancelled.make({ reservationId: input.reservationId }));
    return done({ reservationId: input.reservationId });
  },
});
```

### EventOrNone

[`EventOrNone.cs`](https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/dcb/src/Sekiban.Dcb.Core.Model/Events/EventOrNone.cs)
is the pinned optional-event result shape:

```csharp
public record EventOrNone(EventPayloadWithTags? EventPayloadWithTags, bool HasEvent)
{
    public static EventOrNone Empty => new(default, false);

    public static EventOrNone FromValue(EventPayloadWithTags eventWithTags) =>
        new(eventWithTags, true);

    public EventPayloadWithTags GetValue() =>
        HasEvent && EventPayloadWithTags is not null
            ? EventPayloadWithTags
            : throw new InvalidOperationException("No value");
}
```

The TS terminal union preserves that distinction without a nullable event
payload: `context.append(...)` creates an event, `done(...)` commits it, and
`none(...)` is the explicit no-event branch.

```ts
if (state.status === "released") return none("room is already released");
context.append(roomReleased, roomReleased.make({ roomId: input.roomId }));
return done({ roomId: input.roomId });
```

## Pinned decider/projector correspondence

| C# template concern | TypeScript source anchor |
| --- | --- |
| An event payload is a record with typed fields and an event-owned tag method. | `const reservationCancelled = event(...)` and its `tags: (payload) => ...` deriver. |
| A decider validates before emitting a payload and evolves a closed state. | `validateCancelReservation`, `evolveReservationCancelled`, and `cancelReservationCommand`. |
| A projector registers the event and tag family. | `reservationProjector = projector({ id: "ReservationProjector", tag: reservation, events: [roomReserved, reservationCancelled], ... })`. |

The corresponding command is deliberately explicit in the source:

```ts
export const cancelReservationCommand = command({
  id: "cancel-reservation",
  input: reservationOnlyInput,
  reads: (input) => read(reservationProjector, reservationTag(input.reservationId)),
  handle: async (input, context) => {
    const state = await context.state(reservationProjector, reservationTag(input.reservationId));
    const invalid = validationDecision(validateCancelReservation(state, input));
    if (invalid !== undefined) return invalid;
    const roomId = state.status === "empty" ? undefined : state.roomId;
    context.append(reservationCancelled, reservationCancelled.make({
      reservationId: input.reservationId,
      ...(roomId === null || roomId === undefined ? {} : { roomId }),
    }));
    return done({ reservationId: input.reservationId });
  },
});
```

| Concern | C# authoring shape | TypeScript authoring shape | Portability rule |
| --- | --- | --- | --- |
| Event | `Event<TPayload>` / event definition | `event("RoomCreated", z.object(...), { tags })` | The registered definition assigns the durable `EventType` `RoomCreated`; a payload revision uses a different name. The `version` option is not supported. |
| Tags | `Tag<Room>` / `Tag<Reservation>` | `tagFamily("room").of(roomId)` | Tags are derived from the parsed payload once, retain emission order in the logical event record, and are preserved through V1, stored, Queue, and projection hops. |
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
new payload carries neither a type discriminator nor a caller-selected event
version. Identity-less or versioned stored/Queue input is rejected at ingress;
the G32 wipe cutover has no legacy reader or payload-sniffing fallback.

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
   Unix milliseconds to the C# fixed-width 19-digit .NET tick field, appends
   an allocator-owned 11-digit crypto suffix, and applies
   `max(physicalTicks, observedTicks + 1)` in its write transaction.

No command, event payload, tag deriver, or projector may use the allocator
clock as business time, and no client may supply an event version, eventId, or
SUID. The mapping and compatibility fixtures exercise these ownership
boundaries directly.

## G32 C# logical-event rules

Event schema property names must be camelCase. At admission the original UTF-8
JSON text is checked for syntax and exact member casing, then stored without
reserializing it. The durable record is the C# logical shape
`{ serviceId, id, sortableUniqueId, eventType, payload, tags, timestamp,
causationId, correlationId, executedUser }`: `id` is UUID v7,
`sortableUniqueId` is 30 ASCII digits, and serialized-path metadata is
`(id, "SerializedCommit", "SerializedSekibanExecutor")`. Operational attempt
facts live in the TS sidecar, never in author-facing metadata.

`tools/derive-dcb-tags` can rebuild C# `dcb_tags` rows from these event records.
It is a migration/rebuild tool only: a runtime domain continues to treat the
Tag Durable Object and the event's ordered `family:value` tags as the authority.

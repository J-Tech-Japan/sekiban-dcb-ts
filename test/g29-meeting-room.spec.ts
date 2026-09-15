import { describe, expect, it } from "vitest";
import {
  executeCommand,
  type CandidateEnvelope,
  type EventRecord,
  type ProjectorLike,
  type SnapshotReader,
} from "@sekiban/dcb-domain";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import {
  createRoomCommand,
  meetingRoomEvents,
  meetingRoomDomain,
  meetingRoomRuntimeConfig,
  meetingRoomProjectors,
  releaseRoomCommand,
  reserveRoomCommand,
  roomTag,
  reservationTag,
} from "../samples/meeting-room/src/domain";
import { reservationMaterializer, roomMaterializer } from "../samples/meeting-room/src/d1-mv";
import mapping from "../docs/SDT-G29-mapping.json";
import preRewriteFixture from "./fixtures/g29-pre-rewrite-stored-outbox.json";
import { g32EventId, g32Suid } from "./helpers/g32-fixtures";

function initialState(projector: ProjectorLike): unknown {
  return typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
}

function snapshotReader(states: Readonly<Record<string, unknown>> = {}): SnapshotReader {
  return {
    read: (projector, tag) => ({
      projectorId: projector.id,
      tag,
      head: states[`${projector.id}:${tag.id}`] === undefined ? null : "suid-1",
      state: states[`${projector.id}:${tag.id}`] ?? initialState(projector),
      exists: states[`${projector.id}:${tag.id}`] !== undefined,
    }),
  };
}

function decodeFixtureBytes(encoded: string): Record<string, unknown> {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("G29 pre-rewrite fixture row must be an object");
  if (JSON.stringify(parsed) !== text) throw new Error("G29 pre-rewrite fixture changed byte representation during decode");
  return parsed as Record<string, unknown>;
}

function encodeFixtureBytes(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("SDT-G29 meeting-room authoring portability", () => {
  it("derives the G32 payload-name identity and event-declared tags through the real session", async () => {
    let candidate: CandidateEnvelope | undefined;
    const result = await executeCommand(createRoomCommand, { roomId: "r-g29", name: "Portable" }, {
      timeProvider: { now: () => "business-clock-1" },
      snapshots: snapshotReader(),
      commit: (envelope) => {
        candidate = envelope;
        return { kind: "accepted" };
      },
    });
    expect(result.status).toBe("accepted");
    expect(candidate?.events[0]).toMatchObject({
      eventName: "RoomCreated",
      eventType: "RoomCreated",
      tags: [{ id: "room:r-g29" }],
    });
    expect(candidate?.events[0]?.payload).not.toHaveProperty("eventType");
    expect(mapping.rows.find((row) => row.rowId === "canonical-identity")?.owner).toContain("registered domain");
    expect(mapping.rows.find((row) => row.rowId === "tags")?.doTs).toBe("event.tags(payload)");
  });

  it("replays a G32 history through the discriminated state union without a payload discriminator", () => {
    const projector = meetingRoomProjectors.roomProjector;
    const initial = typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
    const created: EventRecord = {
      eventType: meetingRoomEvents.roomCreated.eventType,
      eventName: meetingRoomEvents.roomCreated.name,
      payload: { roomId: "r-mixed", name: "Created" },
      tags: [roomTag("r-mixed")],
      ordinal: "0",
    };
    const released: EventRecord = {
      eventType: meetingRoomEvents.roomReleased.eventType,
      eventName: meetingRoomEvents.roomReleased.name,
      payload: { roomId: "r-mixed" },
      tags: [roomTag("r-mixed")],
      ordinal: "1",
    };
    const afterCreated = projector.apply(initial, created);
    const afterReleased = projector.apply(afterCreated, released);
    expect(afterReleased).toEqual({ status: "released", version: 2, roomId: "r-mixed", name: "Created" });
  });

  it("preserves the pre-cutover fixture bytes only as a negative: G32 never replays them", () => {
    for (const bytes of [...preRewriteFixture.storedBytes, ...preRewriteFixture.outboxBytes]) {
      const decoded = decodeFixtureBytes(bytes);
      expect(encodeFixtureBytes(decoded)).toBe(bytes);
    }
    const legacyRow = decodeFixtureBytes(preRewriteFixture.storedBytes[0]!);
    expect(() => roomMaterializer.plan(legacyRow as never)).toThrow(SyntaxError);
  });

  it("does not payload-sniff a missing G32 EventType", () => {
    const missingIdentity = {
      eventId: g32EventId("missing-materializer-identity"),
      suid: g32Suid("missing-materializer-identity"),
      payload: JSON.stringify({ eventType: "RoomReserved", reservationId: "missing", roomId: "room" }),
      eventTags: ["reservation:missing"],
      eventType: undefined,
      provenance: "g32" as const,
    };
    expect(reservationMaterializer.plan(missingIdentity as never)).toEqual({ rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] });
  });

  it("preserves the two-tag reservation candidate and release noop", async () => {
    const roomState = { status: "created", version: 1, roomId: "r-booking", name: "Room" };
    let reservationCandidate: CandidateEnvelope | undefined;
    const reserved = await executeCommand(reserveRoomCommand, { roomId: "r-booking", reservationId: "res-g29", userId: "u" }, {
      snapshots: snapshotReader({ "RoomProjector:room:r-booking": roomState }),
      timeProvider: { now: () => 42 },
      commit: (envelope) => {
        reservationCandidate = envelope;
        return { kind: "accepted" };
      },
    });
    expect(reserved.status).toBe("accepted");
    expect(reservationCandidate?.events[0]?.tags.map((tag) => tag.id)).toEqual(["room:r-booking", "reservation:res-g29"]);

    const noop = await executeCommand(releaseRoomCommand, { roomId: "r-booking" }, {
      snapshots: snapshotReader({ "RoomProjector:room:r-booking": { status: "released", version: 2, roomId: "r-booking", name: "Room" } }),
      timeProvider: { now: () => 42 },
    });
    expect(noop.status).toBe("discarded");
    expect(noop.decision.kind).toBe("none");
  });

  it("keeps event identity, allocator fields, and public view policy on separate owners", () => {
    expect(meetingRoomEvents.roomCreated.eventType).toBe("RoomCreated");
    expect(meetingRoomEvents.roomCreated.eventType).not.toContain("eventId");
    expect(meetingRoomEvents.roomCreated.eventType).not.toContain("suid");
    expect(meetingRoomProjectors.reservationProjector.tag.of("r").id).toBe("reservation:r");
    expect(reservationTag("res-g29").id).toBe("reservation:res-g29");
  });

  it("keeps composed polling family-safe for G32 canonical deliveries", () => {
    const composed = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const roomProjector = composed.projectors.resolve("RoomProjector");
    const reservationProjector = composed.projectors.resolve("ReservationProjector");
    expect(roomProjector).toBeDefined();
    expect(reservationProjector).toBeDefined();
    expect(meetingRoomDomain.events.map((value) => value.eventType)).toEqual([
      "RoomCreated",
      "RoomReserved",
      "ReservationCancelled",
      "RoomReleased",
    ]);
    expect((meetingRoomDomain.projectors[1] as { subscribedEventTypes: readonly string[] }).subscribedEventTypes).toEqual([
      "RoomReserved",
      "ReservationCancelled",
    ]);
    const event = {
      eventId: g32EventId("debug"),
      suid: g32Suid("debug"),
      payload: JSON.stringify({ reservationId: "debug", roomId: "room", userId: "user" }),
      eventTags: ["reservation:debug"],
    } as const;
    expect(roomProjector!.apply(roomProjector!.initialState(), { ...event, eventType: "RoomReserved", provenance: "g32" })).toEqual(roomProjector!.initialState());
    expect(reservationProjector!.apply(reservationProjector!.initialState(), { ...event, eventType: "RoomReserved", provenance: "g32" })).toMatchObject({ status: "reserved" });
  });

  it("SDT-G89 AC4: keeps composed polling family-safe when stored eventTags name a foreign family", () => {
    const composed = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const roomProjector = composed.projectors.resolve("RoomProjector");
    const reservationProjector = composed.projectors.resolve("ReservationProjector");
    const event = {
      eventId: g32EventId("foreign"),
      suid: g32Suid("foreign"),
      payload: JSON.stringify({ reservationId: "foreign", roomId: "room", userId: "user" }),
      eventTags: ["reservation:foreign"],
      eventType: "RoomReserved",
      provenance: "g32" as const,
    };
    expect(roomProjector!.apply(roomProjector!.initialState(), event)).toEqual(roomProjector!.initialState());
    expect(reservationProjector!.apply(reservationProjector!.initialState(), event)).toMatchObject({ status: "reserved" });
  });

  it("dispatches materializers by durable G32 identity and never payload-sniffs", () => {
    const payload = (value: unknown) => JSON.stringify(value);
    const canonical = {
      eventId: g32EventId("canonical-reservation"),
      suid: g32Suid("canonical-reservation"),
      payload: payload({ reservationId: "canonical-reservation", roomId: "room", userId: "user" }),
      eventTags: ["reservation:canonical-reservation"],
      eventType: "RoomReserved",
      provenance: "g32" as const,
    };
    expect(reservationMaterializer.plan(canonical).rowUpserts).toHaveLength(1);
    expect(roomMaterializer.plan(canonical)).toEqual({ rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] });

    const droppedIdentity = {
      ...canonical,
      eventId: g32EventId("dropped-reservation"),
      payload: payload({ eventType: "RoomReserved", reservationId: "dropped-reservation", roomId: "room", userId: "user" }),
      eventType: undefined,
    };
    expect(reservationMaterializer.plan(droppedIdentity as never)).toEqual({ rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] });
  });
});

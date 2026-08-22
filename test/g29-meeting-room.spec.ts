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

describe("SDT-G29 meeting-room authoring portability", () => {
  it("derives canonical identity and event-declared tags through the real session", async () => {
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
      eventType: "RoomCreated:1",
      tags: [{ id: "room:r-g29" }],
    });
    expect(candidate?.events[0]?.payload).not.toHaveProperty("eventType");
    expect(mapping.rows.find((row) => row.rowId === "canonical-identity")?.owner).toContain("registered domain");
    expect(mapping.rows.find((row) => row.rowId === "tags")?.doTs).toBe("event.tags(payload)");
  });

  it("replays a mixed legacy/new history through the discriminated state union", () => {
    const projector = meetingRoomProjectors.roomProjector;
    const initial = typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
    const created: EventRecord = {
      eventType: meetingRoomEvents.roomCreated.eventType,
      eventName: meetingRoomEvents.roomCreated.name,
      payload: { eventType: "RoomCreated", roomId: "r-mixed", name: "Legacy" },
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
    expect(afterReleased).toEqual({ status: "released", version: 2, roomId: "r-mixed", name: "Legacy" });
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
    expect(meetingRoomEvents.roomCreated.eventType).toBe("RoomCreated:1");
    expect(meetingRoomEvents.roomCreated.eventType).not.toContain("eventId");
    expect(meetingRoomEvents.roomCreated.eventType).not.toContain("suid");
    expect(meetingRoomProjectors.reservationProjector.tag.of("r").id).toBe("reservation:r");
    expect(reservationTag("res-g29").id).toBe("reservation:res-g29");
  });

  it("keeps composed polling family-safe for legacy and canonical deliveries", () => {
    const composed = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const roomProjector = composed.projectors.resolve("RoomProjector");
    const reservationProjector = composed.projectors.resolve("ReservationProjector");
    expect(roomProjector).toBeDefined();
    expect(reservationProjector).toBeDefined();
    expect(meetingRoomDomain.events.map((value) => value.eventType)).toEqual([
      "RoomCreated:1",
      "RoomReserved:1",
      "ReservationCancelled:1",
      "RoomReleased:1",
    ]);
    expect((meetingRoomDomain.projectors[1] as { subscribedEventTypes: readonly string[] }).subscribedEventTypes).toEqual([
      "RoomReserved:1",
      "ReservationCancelled:1",
    ]);
    const event = {
      eventId: "debug",
      suid: "debug",
      payload: btoa(JSON.stringify({ eventType: "RoomReserved", reservationId: "debug", roomId: "room", userId: "user" })),
      eventTags: ["reservation:debug"],
    } as const;
    expect(roomProjector!.apply(roomProjector!.initialState(), { ...event, provenance: "pre-g27" })).toEqual(roomProjector!.initialState());
    expect(reservationProjector!.apply(reservationProjector!.initialState(), { ...event, provenance: "pre-g27" })).toMatchObject({ status: "reserved" });
    expect(roomProjector!.apply(roomProjector!.initialState(), { ...event, eventType: "RoomReserved:1", provenance: "g27" })).toEqual(roomProjector!.initialState());
    expect(reservationProjector!.apply(reservationProjector!.initialState(), { ...event, eventType: "RoomReserved:1", provenance: "g27" })).toMatchObject({ status: "reserved" });
  });

  it("dispatches materializers by stored identity and fences legacy sniffing to pre-G27 rows", () => {
    const payload = (value: unknown) => btoa(JSON.stringify(value));
    const canonical = {
      eventId: "canonical-reservation",
      suid: "suid-canonical-reservation",
      payload: payload({ reservationId: "canonical-reservation", roomId: "room", userId: "user" }),
      eventTags: ["reservation:canonical-reservation"],
      eventType: "RoomReserved:1",
      provenance: "g27" as const,
    };
    expect(reservationMaterializer.plan(canonical).rowUpserts).toHaveLength(1);
    expect(roomMaterializer.plan(canonical)).toEqual({ rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] });

    const legacy = {
      ...canonical,
      eventId: "legacy-reservation",
      payload: payload({ eventType: "RoomReserved", reservationId: "legacy-reservation", roomId: "room", userId: "user" }),
      eventType: undefined,
      provenance: "pre-g27" as const,
    };
    expect(reservationMaterializer.plan(legacy).rowUpserts).toHaveLength(1);
    expect(reservationMaterializer.plan({ ...legacy, provenance: "g27", eventType: undefined })).toEqual({ rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] });
  });
});

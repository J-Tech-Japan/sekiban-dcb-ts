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

function decodePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("G29 pre-rewrite stored payload is not bytes");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("G29 pre-rewrite payload is not an object");
  return parsed as Record<string, unknown>;
}

function replayCommittedPreRewriteBytes(value = preRewriteFixture) {
  const stored = value.storedBytes.map(decodeFixtureBytes);
  const outbox = value.outboxBytes.map(decodeFixtureBytes);
  if (stored.length !== 2 || outbox.length !== 2) throw new Error("G29 pre-rewrite fixture must contain two stored and two outbox rows");

  const first = stored[0]!;
  const second = stored[1]!;
  const firstPayload = decodePayload(first.payload);
  if (first.eventType !== undefined || first.provenance !== "pre-g27" || typeof firstPayload.eventType !== "string") {
    throw new Error("G29 legacy discriminator/provenance fixture boundary was lost");
  }
  if (second.eventType !== value.expected.canonicalEventType || second.provenance !== "g27") {
    throw new Error("G29 canonical identity/provenance fixture boundary was lost");
  }
  const firstOutbox = outbox[0]!;
  const secondOutbox = outbox[1]!;
  if (firstOutbox.eventId !== first.eventId || firstOutbox.provenance !== "pre-g27-queue" ||
      (firstOutbox.payload as Record<string, unknown>)?.eventType !== "RoomCreated") {
    throw new Error("G29 legacy outbox discriminator was lost");
  }
  if (secondOutbox.eventId !== second.eventId || secondOutbox.eventType !== second.eventType || secondOutbox.provenance !== "g27") {
    throw new Error("G29 G27 outbox identity was lost");
  }

  const projector = meetingRoomProjectors.roomProjector;
  const initial = typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
  const records: EventRecord[] = [
    {
      eventType: `${firstPayload.eventType}:1`,
      eventName: String(firstPayload.eventType),
      payload: firstPayload,
      tags: [roomTag(value.expected.roomId)],
      ordinal: "0",
    },
    {
      eventType: String(second.eventType),
      eventName: String(second.eventType).split(":")[0],
      payload: decodePayload(second.payload),
      tags: [roomTag(value.expected.roomId)],
      ordinal: "1",
    },
  ];
  for (const [index, row] of stored.entries()) {
    const plan = roomMaterializer.plan(row as never);
    if (plan.rowUpserts.length !== 1) throw new Error(`G29 rewritten materializer dropped fixture row ${index}`);
  }
  const afterCreated = projector.apply(initial, records[0]!);
  return projector.apply(afterCreated, records[1]!);
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

  it("replays immutable pre-rewrite stored/outbox bytes through the real materializer and preserves identity", () => {
    expect(replayCommittedPreRewriteBytes()).toEqual({ status: "released", version: 2, roomId: "r-g29-bytes", name: "Legacy bytes" });
    for (const bytes of [...preRewriteFixture.storedBytes, ...preRewriteFixture.outboxBytes]) {
      const decoded = decodeFixtureBytes(bytes);
      expect(encodeFixtureBytes(decoded)).toBe(bytes);
    }
  });

  it("makes loss of either the legacy discriminator or G27 provenance an exact replay failure", () => {
    const withoutLegacyDiscriminator = structuredClone(preRewriteFixture);
    const legacy = decodeFixtureBytes(withoutLegacyDiscriminator.storedBytes[0]!);
    const legacyPayload = decodePayload(legacy.payload);
    delete legacyPayload.eventType;
    legacy.payload = encodeFixtureBytes(legacyPayload);
    withoutLegacyDiscriminator.storedBytes[0] = encodeFixtureBytes(legacy);
    expect(() => replayCommittedPreRewriteBytes(withoutLegacyDiscriminator)).toThrow("legacy discriminator");

    const withoutG27Provenance = structuredClone(preRewriteFixture);
    const canonical = decodeFixtureBytes(withoutG27Provenance.storedBytes[1]!);
    delete canonical.provenance;
    withoutG27Provenance.storedBytes[1] = encodeFixtureBytes(canonical);
    expect(() => replayCommittedPreRewriteBytes(withoutG27Provenance)).toThrow("canonical identity/provenance");
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

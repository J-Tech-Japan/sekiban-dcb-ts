import { describe, expect, it } from "vitest";
import { deriveDcbTags, parseSortableUniqueId } from "../tools/derive-dcb-tags/index.mjs";
import { g32EventId, g32Suid } from "./helpers/g32-fixtures";

const timestamp = "2026-08-22T17:00:00.1230000Z";

describe("SDT-G32 tag rebuild derivation", () => {
  it("collapses duplicate event tags and deterministically orders C# rebuild rows", () => {
    const early = g32Suid("tag-row-1");
    const late = g32Suid("tag-row-2");
    const events = [
      {
        serviceId: "g32-tags",
        id: g32EventId("tag-event-late"),
        sortableUniqueId: late,
        eventType: "RoomReserved",
        payload: "{\"roomId\":\"room-1\"}",
        tags: ["reservation:res-1", "room:room-1", "reservation:res-1"],
        timestamp,
        causationId: null,
        correlationId: null,
        executedUser: null,
      },
      {
        serviceId: "g32-tags",
        id: g32EventId("tag-event-early"),
        sortableUniqueId: early,
        eventType: "RoomCreated",
        payload: "{\"roomId\":\"room-1\"}",
        tags: ["room:room-1"],
        timestamp,
        causationId: g32EventId("tag-event-early"),
        correlationId: "SerializedCommit",
        executedUser: "SerializedSekibanExecutor",
      },
    ];
    const postgres = deriveDcbTags(events, "postgres");
    expect(postgres.map((row) => ({ id: row.id, tag: row.tag, eventId: row.eventId, tagGroup: row.tagGroup, createdAt: row.createdAt }))).toEqual([
      { id: 1, tag: "room:room-1", eventId: g32EventId("tag-event-early"), tagGroup: "room", createdAt: timestamp },
      { id: 2, tag: "reservation:res-1", eventId: g32EventId("tag-event-late"), tagGroup: "reservation", createdAt: timestamp },
      { id: 3, tag: "room:room-1", eventId: g32EventId("tag-event-late"), tagGroup: "room", createdAt: timestamp },
    ]);
    const cosmos = deriveDcbTags(events, "cosmos");
    expect(cosmos).toHaveLength(3);
    expect(cosmos.every((row) => row.pk === `g32-tags|${row.tag}`)).toBe(true);
    expect(cosmos.find((row) => row.eventId === g32EventId("tag-event-early"))?.createdAt).toMatch(/^1970-01-01T00:00:00\.\d{7}Z$/);
  });

  it("rejects out-of-range SUIDs and versioned/non-record rebuild inputs", () => {
    expect(() => parseSortableUniqueId("315537897600000000000000000000")).toThrow(/DateTime/);
    expect(() => deriveDcbTags([{
      serviceId: "g32-tags",
      id: g32EventId("bad-tag-event"),
      sortableUniqueId: g32Suid("tag-row-3"),
      eventType: "RoomReserved:2",
      tags: ["room:room-1"],
      timestamp,
    }], "sqlite")).toThrow(/logical record/);
  });
});

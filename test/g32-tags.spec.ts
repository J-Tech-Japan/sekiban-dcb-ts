import { describe, expect, it } from "vitest";
import {
  assertDcbTagRowsAgainstManifest,
  deriveDcbTags,
  expectedDcbTagRows,
  parseSortableUniqueId,
} from "../tools/derive-dcb-tags/index.mjs";
import type { CosmosDcbTagRow } from "../tools/derive-dcb-tags/index.mjs";
import { g32EventId, g32Suid } from "./helpers/g32-fixtures";
// @ts-expect-error The derivation manifest is the sole provider-row authority.
import manifestSource from "../contracts/dcb-tags-derivation.json?raw";

const timestamp = "2026-08-22T17:00:00.1230000Z";
const manifest = JSON.parse(manifestSource as string) as unknown;

function fixtureEvents() {
  const early = g32Suid("tag-row-1");
  const late = g32Suid("tag-row-2");
  return [
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
}

describe("SDT-G32 tag rebuild derivation", () => {
  it("collapses duplicate event tags and deterministically orders C# rebuild rows", () => {
    const events = fixtureEvents();
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

  it("compares every PostgreSQL/SQLite rebuild field to the manifest-derived contract", () => {
    const events = fixtureEvents();
    const actual = deriveDcbTags(events, "postgres");
    expect(actual).toEqual(expectedDcbTagRows(events, "postgres", manifest));
    expect(assertDcbTagRowsAgainstManifest(events, "postgres", actual, manifest)).toEqual(actual);
  });

  it("compares every Cosmos rebuild field, including pk and id, to the manifest-derived contract", () => {
    const events = fixtureEvents();
    const actual = deriveDcbTags(events, "cosmos");
    expect(actual).toEqual(expectedDcbTagRows(events, "cosmos", manifest));
    expect(assertDcbTagRowsAgainstManifest(events, "cosmos", actual, manifest)).toEqual(actual);
  });

  it("rejects a Cosmos rebuild row with pk removed", () => {
    const events = fixtureEvents();
    const actual = deriveDcbTags(events, "cosmos").map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== "pk"))) as unknown as CosmosDcbTagRow[];
    expect(() => assertDcbTagRowsAgainstManifest(events, "cosmos", actual, manifest)).toThrow(/Cosmos rebuild row/i);
  });

  it("rejects a Cosmos rebuild row with id removed", () => {
    const events = fixtureEvents();
    const actual = deriveDcbTags(events, "cosmos").map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== "id"))) as unknown as CosmosDcbTagRow[];
    expect(() => assertDcbTagRowsAgainstManifest(events, "cosmos", actual, manifest)).toThrow(/Cosmos rebuild row/i);
  });

  it("rejects a Cosmos rebuild row with id replaced", () => {
    const events = fixtureEvents();
    const actual = deriveDcbTags(events, "cosmos").map((row) => ({ ...row, id: "wrong" }));
    expect(() => assertDcbTagRowsAgainstManifest(events, "cosmos", actual, manifest)).toThrow(/Cosmos rebuild row/i);
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

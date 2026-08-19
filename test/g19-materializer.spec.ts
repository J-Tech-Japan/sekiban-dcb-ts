import { describe, expect, it } from "vitest";
import {
  JsonValidationError,
  defineRowMaterializer,
  type MaterializedViewRowMaterializer,
} from "@sekiban/dcb-core";

interface Event {
  suid: string;
  eventId: string;
  count: number;
}

const MATERIALIZER: MaterializedViewRowMaterializer<Event> = defineRowMaterializer({
  id: "g19-materializer-v1",
  version: 1,
  indexDescriptors: [
    { id: "event-id", valueType: "text", value: (_row, event) => event.eventId },
    { id: "count", valueType: "integer", value: (row) => (row as { count: number }).count },
  ],
  materialize: (event) => ({
    rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId, count: event.count } }],
  }),
});

describe("SDT-G19 row materializer definitions", () => {
  it("produces a deterministic finite row/index mutation plan with JSON validation", () => {
    const event = { suid: "suid-1", eventId: "event-1", count: 2 };
    const first = MATERIALIZER.plan(event);
    const second = MATERIALIZER.plan(event);
    expect(first).toEqual(second);
    expect(first.rowUpserts).toEqual([{
      rowKey: "event-1",
      value: { eventId: "event-1", count: 2 },
      rowVersion: 1,
      sourceSuid: "suid-1",
    }]);
    expect(first.indexEntries).toEqual(expect.arrayContaining([
      { indexId: "event-id", valueType: "text", value: "event-1", rowKey: "event-1" },
      { indexId: "count", valueType: "integer", value: 2, rowKey: "event-1" },
    ]));
    expect(() => MATERIALIZER.plan({ ...event, count: Number.NaN })).toThrow(JsonValidationError);
  });

  it("rejects undeclared or non-finite index values instead of creating SQL shape", () => {
    expect(() => defineRowMaterializer({
      id: "bad-index",
      indexDescriptors: [{ id: "count", valueType: "integer", value: () => Number.NaN }],
      materialize: (event: Event) => ({ rowUpserts: [{ rowKey: event.eventId, value: { ok: true } }] }),
    }).plan({ suid: "suid-1", eventId: "event-1", count: 1 })).toThrow(/finite numeric|safe integer/);

    const materializer = defineRowMaterializer({
      id: "undeclared-index",
      indexDescriptors: [{ id: "declared", valueType: "text", value: () => "ok" }],
      materialize: (event: Event) => ({
        rowUpserts: [{ rowKey: event.eventId, value: { ok: true } }],
        indexEntries: [{ indexId: "request-derived", value: "bad", rowKey: event.eventId }],
      }),
    });
    expect(() => materializer.plan({ suid: "suid-1", eventId: "event-1", count: 1 })).toThrow(/MV_INDEX_UNDECLARED/);
  });
});


import { describe, expect, it } from "vitest";

const uiModel = await import("../samples/meeting-room/public/ui-model.js");

describe("SDT-G16 query view model", () => {
  it("distinguishes an empty reservation list from a populated list and retains a read head", () => {
    const empty = uiModel.reservationListView(200, {
      itemsJson: "[]",
      totalCount: 0,
      lastSortedUniqueId: "suid-empty",
    });
    expect(empty).toMatchObject({ kind: "empty", rows: [], totalCount: 0, readHead: "suid-empty" });

    const ready = uiModel.reservationListView(200, {
      itemsJson: JSON.stringify([{ reservationId: "res-1", roomId: "room-1", status: "reserved", version: 2, ignored: "x" }]),
    });
    expect(ready).toEqual({
      kind: "ready",
      rows: [{ reservationId: "res-1", roomId: "room-1", status: "reserved", version: 2 }],
      readHead: undefined,
      continuation: undefined,
      totalCount: 1,
    });
  });

  it("keeps projection-unavailable distinct from a valid empty room result", () => {
    expect(uiModel.reservationListView(503, { error: "unavailable", code: "projection_unavailable" })).toMatchObject({
      kind: "error",
      status: 503,
      code: "projection_unavailable",
    });
    expect(uiModel.roomQueryView(200, { resultJson: JSON.stringify({ count: 0 }), lastSortedUniqueId: "suid-0" })).toEqual({
      kind: "ready",
      result: { count: 0 },
      readHead: "suid-0",
    });
    expect(uiModel.roomQueryView(503, { error: "unavailable", code: "projection_unavailable" })).toMatchObject({
      kind: "error",
      status: 503,
      code: "projection_unavailable",
    });
  });

  it("rejects malformed success payloads instead of rendering a false empty result", () => {
    expect(uiModel.reservationListView(200, { itemsJson: "not-json" })).toMatchObject({
      kind: "error",
      status: 502,
      code: "transport",
    });
    expect(uiModel.roomQueryView(200, { resultJson: "not-json" })).toMatchObject({
      kind: "error",
      status: 502,
      code: "transport",
    });
  });
});

import { describe, expect, it } from "vitest";

const uiModel = await import("../samples/meeting-room/public/ui-model.js");

describe("SDT-G97 portable snapshot reconcile", () => {
  const occupiedReservation = {
    projectorId: "ReservationProjector",
    tag: "reservation:abcd0001",
    head: "suid-old",
    exists: true,
    state: { status: "reserved", version: 1, reservationId: "abcd0001", roomId: "abcd" },
  };

  it("forgets an occupied client snapshot when the server read is empty", () => {
    const decision = uiModel.reconcileOccupiedAgainstRead(
      occupiedReservation,
      200,
      {
        projection: "reservation",
        reservationId: "abcd0001",
        state: { status: "empty", version: 0, reservationId: null, roomId: null },
        lastSortedUniqueId: "",
      },
    );
    expect(decision.action).toBe("forget");
    expect(decision.reason).toBe("server-empty");
  });

  it("does not send a stale occupied reservation when building reserve-room after forget", () => {
    const map = new Map();
    map.set(
      uiModel.snapshotKey("ReservationProjector", "reservation:abcd0001"),
      occupiedReservation,
    );
    map.set(
      uiModel.snapshotKey("RoomProjector", "room:abcd"),
      {
        projectorId: "RoomProjector",
        tag: "room:abcd",
        head: "suid-room",
        exists: true,
        state: { status: "created", version: 1, roomId: "abcd", name: "Demo" },
      },
    );

    const before = uiModel.commandSnapshots(
      "reserve-room",
      { roomId: "abcd", reservationId: "abcd0001", userId: "u1" },
      (projectorId, tag) => map.get(uiModel.snapshotKey(projectorId, tag)),
    );
    expect(before.snapshots.some((s) => s.tag === "reservation:abcd0001" && s.exists === true)).toBe(true);

    const decision = uiModel.reconcileOccupiedAgainstRead(occupiedReservation, 200, {
      state: { status: "empty", version: 0, reservationId: null, roomId: null },
    });
    expect(decision.action).toBe("forget");
    map.delete(uiModel.snapshotKey("ReservationProjector", "reservation:abcd0001"));

    const after = uiModel.commandSnapshots(
      "reserve-room",
      { roomId: "abcd", reservationId: "abcd0001", userId: "u1" },
      (projectorId, tag) => map.get(uiModel.snapshotKey(projectorId, tag)),
    );
    const reservationSnap = after.snapshots.find((s) => s.tag === "reservation:abcd0001");
    expect(reservationSnap).toBeDefined();
    expect(reservationSnap.exists).toBe(false);
    expect(reservationSnap.state.status).toBe("empty");
  });

  it("refreshes from a non-empty server read instead of inventing emptiness", () => {
    const decision = uiModel.reconcileOccupiedAgainstRead(
      occupiedReservation,
      200,
      {
        state: { status: "reserved", version: 2, reservationId: "abcd0001", roomId: "abcd" },
        lastSortedUniqueId: "suid-new",
      },
    );
    expect(decision.action).toBe("refresh");
    expect(decision.snapshot.head).toBe("suid-new");
    expect(decision.snapshot.state.version).toBe(2);
  });

  it("lists create/reserve tags for pre-command reconcile", () => {
    expect(uiModel.tagsToReconcileForCommand("reserve-room", {
      roomId: "r1",
      reservationId: "x1",
    })).toEqual([
      { kind: "room", id: "r1", projectorId: "RoomProjector", tag: "room:r1" },
      { kind: "reservation", id: "x1", projectorId: "ReservationProjector", tag: "reservation:x1" },
    ]);
  });
});

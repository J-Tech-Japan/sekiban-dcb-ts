import { describe, expect, it } from "vitest";
import { inspectG66Receipt } from "../scripts/g66-e2e-guard.mjs";

type G66Visibility = {
  disposition: string;
  boundMs: number;
  firstVisibleAtMs?: number;
  responseRelativeMs?: number;
  safeHead?: string;
  publicQuery?: { status: number };
  observations?: unknown[];
};

type G66Sample = {
  target: { kind: "room" | "reservation"; id: string; expectedStatus: string };
  commit: {
    status: number;
    kind: string;
    suid: string;
    startedAtMs: number;
    completedAtMs: number;
    responseMs: number;
    executor: { readMode: string };
  };
  healthSnapshots: Array<{ coverage: { kind: string }; coverageHistory: unknown[]; safeLanePasses: unknown[] }>;
  tagReads: Array<{ status: number; version: number; expectedVersion: number; lastSortedUniqueId: string; expectedSuid: string }>;
  queryReads: {
    room: { status: number; result?: { count: number }; readHead: string | null };
    reservations: { status: number; readHead: string; rows: Array<{ reservationId: string; roomId: string; status: string }> };
  };
  unsafe: G66Visibility;
  safe: G66Visibility;
};

type G66Fixture = {
  schema: string;
  contract: { coldFirst: boolean; minimumInterSampleMs: number };
  healthSnapshots: G66Sample["healthSnapshots"];
  commands: G66Sample[];
};

function fixture(): G66Fixture {
  const health = { coverage: { kind: "SETTLED" }, coverageHistory: [], safeLanePasses: [] };
  return {
    schema: "sdt-g66-public-e2e/v1",
    contract: { coldFirst: true, minimumInterSampleMs: 10_000 },
    healthSnapshots: [health],
    commands: Array.from({ length: 10 }, (_, index) => {
      const suid = String(index + 1).padStart(30, "0");
      const isRoom = index === 0;
      const id = isRoom ? "room-1" : "reservation-1";
      const expectedStatus = index === 9 ? "cancelled" : "reserved";
      return {
        target: { kind: isRoom ? "room" : "reservation", id, expectedStatus: isRoom ? "created" : expectedStatus },
        commit: {
          status: 200,
          kind: "committed",
          suid,
          startedAtMs: index * 10_000,
          completedAtMs: index * 10_000 + 10,
          responseMs: 10,
          executor: { readMode: isRoom || index === 1 ? "read-through" : "snapshot-only" },
        },
        healthSnapshots: [health],
        tagReads: [{ status: 200, version: 1, expectedVersion: 1, lastSortedUniqueId: suid, expectedSuid: suid }],
        queryReads: {
          room: { status: 200, result: { count: 1 }, readHead: null },
          reservations: { status: 200, readHead: suid, rows: isRoom ? [] : [{ reservationId: id, roomId: "room-1", status: expectedStatus }] },
        },
        unsafe: { disposition: "pass", boundMs: 5_000, firstVisibleAtMs: index * 10_000 + 20, responseRelativeMs: 10, observations: [{ visible: true }] },
        safe: { disposition: "pass", boundMs: 180_000, firstVisibleAtMs: index * 10_000 + 20_000, responseRelativeMs: 19_990, safeHead: suid, publicQuery: { status: 200 } },
      };
    }),
  };
}

describe("SDT-G66 public e2e guard", () => {
  it("accepts a complete cold-first receipt with continuous paced writes", () => {
    expect(inspectG66Receipt(fixture()).passed).toBe(true);
  });

  it("fails closed for censored safe visibility", () => {
    const receipt = fixture();
    receipt.commands[0].safe = { disposition: "censored", boundMs: 180_000 };
    expect(inspectG66Receipt(receipt).passed).toBe(false);
  });

  it("rejects pause-to-safe, missing clocks, bad public reads and late-success mutants", () => {
    const paused = fixture();
    paused.commands[1].commit.startedAtMs = paused.commands[0].safe.firstVisibleAtMs! + paused.contract.minimumInterSampleMs;
    paused.commands[1].commit.completedAtMs = paused.commands[1].commit.startedAtMs + paused.commands[1].commit.responseMs;
    expect(inspectG66Receipt(paused).passed).toBe(false);

    const missingUnsafe = fixture();
    delete missingUnsafe.commands[0].unsafe.firstVisibleAtMs;
    delete missingUnsafe.commands[0].unsafe.responseRelativeMs;
    expect(inspectG66Receipt(missingUnsafe).passed).toBe(false);

    const badQuery = fixture();
    badQuery.commands[0].queryReads.reservations.status = 500;
    expect(inspectG66Receipt(badQuery).passed).toBe(false);

    const late = fixture();
    late.commands[0].safe.firstVisibleAtMs = late.commands[0].commit.completedAtMs + 180_001;
    late.commands[0].safe.responseRelativeMs = 180_001;
    expect(inspectG66Receipt(late).passed).toBe(false);
  });

  it("retains hard failures for rejected writes and missing coverage", () => {
    const failedWrite = fixture();
    failedWrite.commands[0].commit.status = 504;
    expect(() => inspectG66Receipt(failedWrite)).toThrow();

    const coverage = fixture();
    coverage.commands[0].healthSnapshots[0].coverageHistory = null as unknown as unknown[];
    expect(() => inspectG66Receipt(coverage)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type {
  GlobalCompletenessCoverage,
  GlobalCompletenessHealthRecord,
} from "../packages/dcb-runtime/src/completeness/types";
import { runMeetingRoomScheduledMaintenance } from "../samples/meeting-room/src/worker.cloudflare-only";
import { g32Suid } from "./helpers/g32-fixtures";

const staleFrontier = g32Suid(4);
const freshlyScannedFrontier = g32Suid(10);

function health(frontierSuid: string): GlobalCompletenessHealthRecord {
  return {
    serviceId: "g58-diagnosis",
    scannerVersion: "sdt-g44-global-completeness/v1",
    status: "HEALTHY",
    cursorJson: null,
    lastSettledFrontierSuid: frontierSuid,
    lastFullScanAt: 1,
    lastError: null,
    updatedAt: 1,
  };
}

function settled(frontierSuid: string, observedAt: number): GlobalCompletenessCoverage {
  return {
    kind: "SETTLED",
    health: health(frontierSuid),
    frontierSuid,
    reason: null,
    partitionTag: null,
    observedAt,
  };
}

describe("SDT-G58 W97 same-tick frontier repair", () => {
  it("W97 GREEN: applies a freshly scanned FULL frontier in the same scheduled tick", async () => {
    const order: string[] = [];
    let safeHead = "";

    await runMeetingRoomScheduledMaintenance({
      // The repaired runtime computes this result after the fresh scanner and
      // before safe catch-up, so the newly proven frontier is not delayed to a
      // later cron tick.
      freshCoverage: async () => {
        order.push("fresh-scan");
        return settled(freshlyScannedFrontier, 2);
      },
      recordCoverage: async () => {
        order.push("record-coverage");
      },
      catchUp: async (frontierSuid) => {
        order.push(`catch-up:${frontierSuid ?? "null"}`);
        safeHead = frontierSuid ?? "";
      },
      drainUnsafeKicks: async (frontierSuid) => {
        order.push(`drain:${frontierSuid ?? "null"}`);
      },
      runGenericScheduledWork: async () => { order.push("live-poll"); },
    });

    expect(order).toEqual([
      "fresh-scan",
      "record-coverage",
      `catch-up:${freshlyScannedFrontier}`,
      `drain:${freshlyScannedFrontier}`,
      "live-poll",
    ]);
    expect(safeHead).toBe(freshlyScannedFrontier);
  });

  it("keeps only the last proven frontier and records the reason on a BLOCK tick", async () => {
    const order: string[] = [];
    let observed: { kind: string; reason: string | null; frontierSuid: string | null } | undefined;
    let safeHead = "";

    await runMeetingRoomScheduledMaintenance({
      freshCoverage: async () => ({
        ...settled(staleFrontier, 3),
        kind: "BLOCK/UNSETTLED" as const,
        reason: "source present/global receipt absent",
        partitionTag: "room:g58-blocked",
      }),
      recordCoverage: async (coverage) => {
        observed = coverage;
        order.push("record-coverage");
      },
      catchUp: async (frontierSuid) => {
        safeHead = frontierSuid ?? "";
        order.push(`catch-up:${frontierSuid ?? "null"}`);
      },
      drainUnsafeKicks: async (frontierSuid) => { order.push(`drain:${frontierSuid ?? "null"}`); },
      runGenericScheduledWork: async () => { order.push("live-poll"); },
    });

    expect(safeHead).toBe(staleFrontier);
    expect(observed).toMatchObject({
      kind: "BLOCK/UNSETTLED",
      reason: "source present/global receipt absent",
      frontierSuid: staleFrontier,
    });
    expect(order).toEqual([
      "record-coverage",
      `catch-up:${staleFrontier}`,
      `drain:${staleFrontier}`,
      "live-poll",
    ]);
  });
});

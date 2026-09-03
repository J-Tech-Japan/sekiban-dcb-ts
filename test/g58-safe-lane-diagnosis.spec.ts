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

describe("SDT-G58 W96 diagnosis guard", () => {
  it("W96 RED: applies a freshly scanned FULL frontier in the same scheduled tick", async () => {
    const order: string[] = [];
    let safeHead = "";
    let freshFrontierAvailable = false;

    await runMeetingRoomScheduledMaintenance({
      // W95 observed this stale persisted frontier before the scheduled scan
      // completed. A future repair must make the fresh FULL result available
      // to the safe lane in this same tick, without crossing an unproven gap.
      globalCoverage: async () => {
        order.push("read-persisted-frontier");
        return settled(staleFrontier, 1);
      },
      recordCoverage: async () => {
        order.push("record-coverage");
      },
      catchUp: async (frontierSuid) => {
        order.push(`catch-up:${frontierSuid ?? "null"}`);
        safeHead = frontierSuid ?? "";
        if (freshFrontierAvailable) safeHead = freshlyScannedFrontier;
      },
      drainUnsafeKicks: async (frontierSuid) => {
        order.push(`drain:${frontierSuid ?? "null"}`);
      },
      runGenericScheduledWork: async () => {
        order.push("fresh-scan");
        // Simulate the generic runtime's fresh G44 scan. The broken scheduler
        // never gives this newly proven frontier back to catch-up this tick.
        freshFrontierAvailable = true;
      },
    });

    expect(order).toEqual([
      "read-persisted-frontier",
      "record-coverage",
      `catch-up:${staleFrontier}`,
      `drain:${staleFrontier}`,
      "fresh-scan",
    ]);
    // Intentionally red on the current baseline (9b21259). Keep this witness
    // until the focused green repair proves same-tick frontier application.
    expect(safeHead).toBe(freshlyScannedFrontier);
  });
});

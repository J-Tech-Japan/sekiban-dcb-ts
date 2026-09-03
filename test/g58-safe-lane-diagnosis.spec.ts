import { describe, expect, it } from "vitest";
import type {
  GlobalCompletenessCoverage,
  GlobalCompletenessHealthRecord,
} from "../packages/dcb-runtime/src/completeness/types";
import {
  scheduledLiveProjectionMaximumSuid,
} from "../packages/dcb-runtime/src/cloudflare";
import { ProjectionRuntime, projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { DEPLOYED_PROJECTOR_REGISTRY } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type { ProjectionCheckpoint, ProjectionStore } from "../packages/dcb-runtime/src/store/types";
import { runMeetingRoomScheduledMaintenance } from "../samples/meeting-room/src/worker.cloudflare-only";
import { g32StoredEvent, g32Message, g32Suid } from "./helpers/g32-fixtures";

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

  it("W104 GREEN: polls a BLOCK tick through only its retained frontier while FULL stays unbounded", async () => {
    const stale = g32Suid(1);
    const unproven = g32Suid(2);
    expect(scheduledLiveProjectionMaximumSuid({ kind: "FULL" }, stale)).toBeUndefined();
    expect(scheduledLiveProjectionMaximumSuid({ kind: "BLOCK" }, stale)).toBe(stale);
    expect(scheduledLiveProjectionMaximumSuid({ kind: "BLOCK" }, null)).toBeNull();

    const serviceId = `g58-block-live-${crypto.randomUUID()}`;
    const tag = `room:${serviceId}`;
    const first = g32StoredEvent(g32Message({ serviceId, tag, eventId: `${serviceId}-first`, suid: stale, eventTags: [tag] }), 0);
    const second = g32StoredEvent(g32Message({ serviceId, tag, eventId: `${serviceId}-second`, suid: unproven, eventTags: [tag] }), 0);
    let checkpoint: ProjectionCheckpoint | undefined;
    const source: ProjectionStore = {
      readAllEvents: async (_serviceId, since) => [first, second].filter((event) => event.suid > since),
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async () => checkpoint,
      advanceProjectionCheckpoint: async (input) => {
        checkpoint = { ...input };
        return true;
      },
      projectionLag: async () => ({
        serviceId,
        projectionId: projectionIdFor({ tag, tagGroup: "room", tagContent: serviceId, tagProjector: "test-projector" }),
        tag,
        checkpointSuid: checkpoint?.lastSuid ?? "",
        headSuid: second.suid,
        behindEvents: checkpoint?.lastSuid === second.suid ? 0 : 1,
      }),
      appendDeliveryIncident: async () => undefined,
    };
    const runtime = new ProjectionRuntime(source, DEPLOYED_PROJECTOR_REGISTRY);
    const blocked = await runtime.pollRegistered(serviceId, 100_000, stale);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ advancedSourceEvents: 1, appliedEvents: 1 });
    expect(checkpoint?.lastSuid).toBe(stale);

    const noFrontier = await runtime.pollRegistered(serviceId, 100_000, null);
    expect(noFrontier).toHaveLength(1);
    expect(noFrontier[0]).toMatchObject({ advancedSourceEvents: 0, appliedEvents: 0 });
    expect(checkpoint?.lastSuid).toBe(stale);

    const full = await runtime.pollRegistered(serviceId, 100_000);
    expect(full[0]).toMatchObject({ advancedSourceEvents: 1, appliedEvents: 1 });
    expect(checkpoint?.lastSuid).toBe(unproven);
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

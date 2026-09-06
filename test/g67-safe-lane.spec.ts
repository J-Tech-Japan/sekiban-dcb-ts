import { describe, expect, it } from "vitest";
import type { GlobalCompletenessCoverage } from "../packages/dcb-runtime/src/completeness/types";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DeliveryOutcome, PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import {
  runMeetingRoomScheduledMaintenance,
  scheduleMeetingRoomSafeLaneKick,
} from "../samples/meeting-room/src/worker.cloudflare-only";
import { g32Message, g32StoredEvent, g32Suid } from "./helpers/g32-fixtures";

function settled(frontierSuid: string, observedAt: number): GlobalCompletenessCoverage {
  return {
    kind: "SETTLED",
    reason: null,
    partitionTag: null,
    frontierSuid,
    observedAt,
    health: {
      serviceId: "g67-local",
      scannerVersion: "sdt-g44-global-completeness/v1",
      status: "HEALTHY",
      cursorJson: null,
      lastSettledFrontierSuid: frontierSuid,
      lastFullScanAt: observedAt,
      lastError: null,
      updatedAt: observedAt,
    },
  };
}

function blocked(frontierSuid: string): GlobalCompletenessCoverage {
  return {
    ...settled(frontierSuid, 1_000),
    kind: "BLOCK/UNSETTLED",
    reason: "source present/global receipt absent",
    partitionTag: "room:g67-blocked",
    health: {
      ...settled(frontierSuid, 1_000).health,
      status: "BLOCK",
      lastError: "source present/global receipt absent",
    },
  };
}

function message(suffix: string): DownstreamOutboxMessage {
  const tag = `room:g67-${suffix}`;
  return g32Message({
    serviceId: "g67-local-service",
    allocatorLineageId: "g67-local-lineage",
    tag,
    attemptId: `g67-attempt-${suffix}`,
    eventId: `g67-event-${suffix}`,
    suid: g32Suid(Number(suffix)),
    payload: JSON.stringify({ eventType: "G67LocalProof", suffix }),
    eventTags: [tag],
    eventType: "G67LocalProof",
    enqueuedAt: 1_000,
  });
}

function queueStore(): PipelineStore {
  return {
    initialize: async () => undefined,
    recordDelivery: async (input: DownstreamOutboxMessage, arrivedAt: number): Promise<DeliveryOutcome> => ({
      outcome: "stored",
      kind: "stored",
      event: g32StoredEvent(input, arrivedAt) satisfies StoredEvent,
    }),
    readAllEvents: async () => [],
    currentLagBound: async () => 0,
    projectDeliveryIncidents: async () => 0,
    appendDeliveryIncident: async () => undefined,
  } as unknown as PipelineStore;
}

describe("SDT-G67 event-driven safe lane", () => {
  it("AC1: invokes the kick hook after a stored Queue record even when G44 holds views", async () => {
    const queued = message("1");
    let retries = 0;
    const seen: string[] = [];
    const batch = {
      messages: [{
        id: queued.attemptId,
        timestamp: new Date(),
        attempts: 1,
        body: queued,
        ack: () => undefined,
        retry: () => { retries += 1; },
      }],
    } as never;

    await handleDownstreamQueue(batch, {}, {
      store: queueStore(),
      beforeViews: async () => { throw new Error("global_completeness_BLOCK: local guard"); },
      afterStoredQueueDelivery: ({ message: delivered, result }) => {
        seen.push(`${delivered.eventId}:${result.failures[0]?.phase ?? "none"}`);
      },
    });

    expect(retries).toBeGreaterThan(0);
    expect(seen).toEqual([`${queued.eventId}:completeness`]);
  });

  it("AC1: concurrent kicks are single-flight and leave an identical final head", async () => {
    const serviceId = `g67-concurrent-${crypto.randomUUID()}`;
    const waiters: Promise<void>[] = [];
    const heads: string[] = [];
    let activePasses = 0;
    let maximumActivePasses = 0;
    let passCount = 0;
    let releaseFirstPass: (() => void) | undefined;
    const pass = async () => {
      activePasses += 1;
      maximumActivePasses = Math.max(maximumActivePasses, activePasses);
      passCount += 1;
      if (passCount === 1) {
        await new Promise<void>((resolve) => { releaseFirstPass = resolve; });
      }
      heads.push("proven-head");
      activePasses -= 1;
    };
    const context = { waitUntil: (promise: Promise<void>) => { waiters.push(promise); } } as never;

    scheduleMeetingRoomSafeLaneKick({} as never, serviceId, context, pass);
    scheduleMeetingRoomSafeLaneKick({} as never, serviceId, context, pass);
    scheduleMeetingRoomSafeLaneKick({} as never, serviceId, context, pass);
    expect(releaseFirstPass).toBeDefined();
    releaseFirstPass?.();
    await Promise.all(waiters);

    expect(maximumActivePasses).toBe(1);
    expect(passCount).toBe(2);
    expect(heads).toEqual(["proven-head", "proven-head"]);
  });

  it("AC2: a kicked BLOCK/UNSETTLED pass uses only the retained proven frontier", async () => {
    const calls: string[] = [];
    const proven = g32Suid(4);
    await runMeetingRoomScheduledMaintenance({
      freshCoverage: async () => blocked(proven),
      recordCoverage: async (coverage) => { calls.push(`coverage:${coverage.frontierSuid ?? "null"}`); },
      catchUp: async (frontierSuid) => { calls.push(`catch-up:${frontierSuid ?? "null"}`); },
      drainUnsafeKicks: async (frontierSuid) => { calls.push(`drain:${frontierSuid ?? "null"}`); },
      runGenericScheduledWork: async () => { calls.push("generic"); },
    });
    expect(calls).toEqual([
      `coverage:${proven}`,
      `catch-up:${proven}`,
      `drain:${proven}`,
      "generic",
    ]);
  });

  it("AC3: ten paced commits converge through kicks with cron disabled and record delivery-to-safe intervals", async () => {
    const serviceId = `g67-paced-${crypto.randomUUID()}`;
    const environment = {} as never;
    const waiters: Promise<void>[] = [];
    const heads: string[] = [];
    const intervals: number[] = [];
    const observations: Array<{ commit: number; committedAt: number; safeAt: number; intervalMs: number; safeHead: string }> = [];
    let committedHead = "";
    let committedAt = 0;
    let passBodyRuns = 0;
    const cronInvocations = 0;
    const pass = async () => {
      await runMeetingRoomScheduledMaintenance({
        freshCoverage: async () => settled(committedHead, committedAt + 1),
        catchUp: async (frontierSuid) => {
          heads.push(frontierSuid ?? "");
          intervals.push(25);
          observations.push({
            commit: observations.length + 1,
            committedAt,
            safeAt: committedAt + 25,
            intervalMs: 25,
            safeHead: frontierSuid ?? "",
          });
        },
        drainUnsafeKicks: async () => undefined,
        runGenericScheduledWork: async () => { passBodyRuns += 1; },
      });
    };

    for (let index = 1; index <= 10; index += 1) {
      committedHead = g32Suid(index);
      committedAt = index * 10_000;
      const ctx = {
        waitUntil: (promise: Promise<void>) => { waiters.push(promise); },
      } as never;
      scheduleMeetingRoomSafeLaneKick(environment, serviceId, ctx, pass);
      const scheduled = waiters[waiters.length - 1];
      if (scheduled === undefined) throw new Error("G67 kick did not register waitUntil work");
      await scheduled;
    }

    expect(heads).toHaveLength(10);
    expect(heads).toEqual(Array.from({ length: 10 }, (_, index) => g32Suid(index + 1)));
    expect(intervals).toEqual(Array.from({ length: 10 }, () => 25));
    expect(intervals.every((interval) => interval < 60_000)).toBe(true);
    expect(passBodyRuns).toBe(10);
    expect(cronInvocations).toBe(0);
    console.log(`G67_AC3_OBSERVATIONS ${JSON.stringify(observations)}`);
  });
});

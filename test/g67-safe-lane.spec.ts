import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration import.
import pipelineMigration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import unsafeMvMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import hardeningMvMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration import.
import unsafeFailureMvMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration import.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration import.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
import type { GlobalCompletenessCoverage } from "../packages/dcb-runtime/src/completeness/types";
import { createCloudflareOnlyRuntimeWorker, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/cloudflare";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DeliveryOutcome, PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { D1EventStore, D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1";
import {
  runMeetingRoomScheduledMaintenance,
  scheduleMeetingRoomSafeLaneKick,
} from "../samples/meeting-room/src/worker.cloudflare-only";
import {
  recordMeetingRoomSafeLanePass,
} from "../samples/meeting-room/src/d1-mv";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import { g32Message, g32StoredEvent, g32Suid, g32SuidAt } from "./helpers/g32-fixtures";

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

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

function mvDatabase(): D1Database {
  const database = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (database === undefined) throw new Error("G67 requires the D1_MV binding");
  return database;
}

function sourceNamespace(messageValue: DownstreamOutboxMessage): DurableObjectNamespace {
  const source = {
    async fetch(request: Request): Promise<Response> {
      const input = await request.json<{
        readonly afterSequence: number;
        readonly upperBoundSequence: number;
      }>();
      const obligation = {
        ...messageValue.completeness,
        eventId: messageValue.eventId,
        status: "acknowledged" as const,
      };
      const rows = input.afterSequence < 1 && input.upperBoundSequence >= 1 ? [obligation] : [];
      return new Response(JSON.stringify({
        serviceId: messageValue.serviceId,
        tag: messageValue.tag,
        upperBoundSequence: input.upperBoundSequence,
        observedMaxSequence: input.upperBoundSequence,
        afterSequence: input.afterSequence,
        rows,
        hasMore: false,
      }), { headers: { "content-type": "application/json" } });
    },
  };
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => source as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function reservationDelivery(serviceId: string, arrivedAt: number): DownstreamOutboxMessage {
  const suffix = crypto.randomUUID();
  const room = `room:g67-safe-${suffix}`;
  const reservation = `reservation:g67-safe-${suffix}`;
  return g32Message({
    serviceId,
    tag: room,
    attemptId: `g67-queue-attempt-${suffix}`,
    eventId: `g67-queue-event-${suffix}`,
    suid: g32SuidAt(arrivedAt, `g67-queue-suid-${suffix}`),
    payload: JSON.stringify({
      roomId: room,
      reservationId: reservation,
      userId: "g67-local-user",
    }),
    eventTags: [room, reservation],
    eventType: "RoomReserved",
    enqueuedAt: arrivedAt,
    obligationSequence: 1,
  });
}

beforeAll(async () => {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G67 requires the D1 pipeline binding");
  await database.batch(statements(database, pipelineMigration as string));
  await applyG44D1Migration(database);
  for (const migration of [mvMigration, unsafeMvMigration, hardeningMvMigration, unsafeFailureMvMigration, g31WaitReceiptMigration, g31WaitPoisonMigration]) {
    await mvDatabase().batch(statements(mvDatabase(), migration as string));
  }
});

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

  it("AC1: Queue kick hook is notification-only", async () => {
    const queued = message("notification-only");
    const neverSettles = new Promise<void>(() => undefined);
    const batch = {
      messages: [{
        id: queued.attemptId,
        timestamp: new Date(),
        attempts: 1,
        body: queued,
        ack: () => undefined,
        retry: () => undefined,
      }],
    } as never;

    const result = await Promise.race([
      handleDownstreamQueue(batch, {}, {
        store: queueStore(),
        beforeViews: async () => { throw new Error("global_completeness_BLOCK: notification-only guard"); },
        // A pre-repair adapter awaited this returned promise. The production
        // callback is void, but this red-capable probe deliberately returns a
        // never-settling promise to prove the adapter cannot await it.
        afterStoredQueueDelivery: () => neverSettles,
      }).then(() => "returned" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);
    expect(result).toBe("returned");
  });

  it("AC1: persists kick scheduling, completion, and coverage provenance separately from cron", async () => {
    const database = (env as unknown as { D1?: D1Database }).D1;
    if (database === undefined) throw new Error("G67 requires the D1 pipeline binding");
    const serviceId = `g67-pass-ledger-${crypto.randomUUID()}`;
    const passId = `kick:${crypto.randomUUID()}`;
    const coverage = settled(g32Suid(7), 7_000);
    const passEnv = { D1: database };
    const deliveryOwner = {
      eventId: "g67-event-7",
      suid: g32Suid(7),
      attemptId: "g67-attempt-7",
      partitionTag: "room:g67-7",
      obligationSequence: 7,
    };
    await recordMeetingRoomSafeLanePass(passEnv, {
      serviceId,
      passId,
      trigger: "kick",
      status: "scheduled",
      scheduledAt: 7_001,
      deliveryOwner,
    });
    await recordMeetingRoomSafeLanePass(passEnv, {
      serviceId,
      passId,
      trigger: "kick",
      status: "running",
      scheduledAt: 7_001,
      startedAt: 7_002,
      deliveryOwner,
    });
    await recordMeetingRoomSafeLanePass(passEnv, {
      serviceId,
      passId,
      trigger: "kick",
      status: "completed",
      scheduledAt: 7_001,
      startedAt: 7_002,
      completedAt: 7_010,
      coverage,
      deliveryOwner,
      safeHeadsBeforeJson: "[{\"projectionId\":\"room\",\"head\":\"\"}]",
      safeHeadsAfterJson: `[{"projectionId":"room","head":"${coverage.frontierSuid}"}]`,
      catchUpStartedAt: 7_003,
      catchUpCompletedAt: 7_009,
      catchUpOutcome: "completed",
    });
    const row = await database.prepare(
      `SELECT trigger, status, scheduled_at, started_at, completed_at,
              coverage_kind, settled_frontier_suid, safe_heads_before_json,
              safe_heads_after_json, delivery_event_id, delivery_attempt_id,
              delivery_suid, delivery_partition_tag, delivery_obligation_sequence,
              catch_up_started_at, catch_up_completed_at, catch_up_outcome
         FROM serialized_dcb_safe_lane_passes
        WHERE service_id = ? AND pass_id = ?`,
    ).bind(serviceId, passId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      trigger: "kick",
      status: "completed",
      scheduled_at: 7_001,
      started_at: 7_002,
      completed_at: 7_010,
      coverage_kind: "SETTLED",
      settled_frontier_suid: coverage.frontierSuid,
      delivery_event_id: "g67-event-7",
      delivery_suid: g32Suid(7),
      delivery_attempt_id: "g67-attempt-7",
      delivery_partition_tag: "room:g67-7",
      delivery_obligation_sequence: 7,
      catch_up_started_at: 7_003,
      catch_up_completed_at: 7_009,
      catch_up_outcome: "completed",
    });
    expect(row?.safe_heads_before_json).toContain("projectionId");
    expect(row?.safe_heads_after_json).toContain(coverage.frontierSuid);
  });

  it("AC1: concurrent kicks are single-flight and leave an identical final head", async () => {
    const serviceId = `g67-concurrent-${crypto.randomUUID()}`;
    const waiters: Promise<void>[] = [];
    const heads: string[] = [];
    let activePasses = 0;
    let maximumActivePasses = 0;
    let passCount = 0;
    const ownerEvents: string[] = [];
    let releaseFirstPass: (() => void) | undefined;
    const pass = async (_env: object, _serviceId: string, request?: { owner?: { eventId: string } }) => {
      activePasses += 1;
      maximumActivePasses = Math.max(maximumActivePasses, activePasses);
      passCount += 1;
      ownerEvents.push(request?.owner?.eventId ?? "missing-owner");
      if (passCount === 1) {
        await new Promise<void>((resolve) => { releaseFirstPass = resolve; });
      }
      heads.push("proven-head");
      activePasses -= 1;
    };
    const context = { waitUntil: (promise: Promise<void>) => { waiters.push(promise); } } as never;
    const owner = (eventId: string) => ({
      eventId,
      suid: g32Suid(eventId),
      attemptId: `${eventId}-attempt`,
      partitionTag: `${eventId}-partition`,
      obligationSequence: 1,
    });

    scheduleMeetingRoomSafeLaneKick({} as never, serviceId, context, pass, owner("event-1"));
    scheduleMeetingRoomSafeLaneKick({} as never, serviceId, context, pass, owner("event-2"));
    scheduleMeetingRoomSafeLaneKick({} as never, serviceId, context, pass, owner("event-3"));
    // The production path deliberately defers scheduler start until after
    // waitUntil registration; allow that non-blocking handoff to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(releaseFirstPass).toBeDefined();
    releaseFirstPass?.();
    await Promise.all(waiters);

    expect(maximumActivePasses).toBe(1);
    expect(passCount).toBe(2);
    expect(heads).toEqual(["proven-head", "proven-head"]);
    expect(ownerEvents).toEqual(["event-1", "event-3"]);
  });

  it("AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader", async () => {
    const database = (env as unknown as { D1?: D1Database }).D1;
    if (database === undefined) throw new Error("G67 requires the D1 pipeline binding");
    const serviceId = `g67-handoff-${crypto.randomUUID()}`;
    const arrivedAt = Date.now() - 60_000;
    const queued = reservationDelivery(serviceId, arrivedAt);
    const source = new D1EventStore(database);
    await source.initialize();
    await expect(source.recordDelivery(queued, arrivedAt, "queue")).resolves.toMatchObject({ outcome: "stored" });

    const passEnvironment = {
      D1: database,
      D1_MV: mvDatabase(),
      TAG: sourceNamespace(queued),
      SDT_SERVICE_ID: serviceId,
    } as never;
    const waiters: Promise<void>[] = [];
    const context = {
      waitUntil: (promise: Promise<void>) => { waiters.push(promise); },
    } as never;
    scheduleMeetingRoomSafeLaneKick(passEnvironment, serviceId, context, undefined, {
      eventId: queued.eventId,
      suid: queued.suid,
      attemptId: queued.attemptId,
      partitionTag: queued.tag,
      obligationSequence: queued.completeness.obligationSequence,
    });
    await Promise.all(waiters);

    const views = new D1MaterializedViewStore(mvDatabase());
    await views.initialize();
    const safePage = await views.readListPage(serviceId, "ReservationProjector", { consistency: "safe", limit: null });
    expect(safePage.rows).toEqual([expect.objectContaining({ sourceSuid: queued.suid })]);
    const publicRuntime = createCloudflareOnlyRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });
    const publicFetch = publicRuntime.fetch as unknown as (request: Request, requestEnv: unknown, requestContext: ExecutionContext) => Promise<Response>;
    const publicResponse = await publicFetch(new Request("https://g67.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
      body: JSON.stringify({
        queryType: "GetReservationListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, consistency: "safe" }),
      }),
    }), passEnvironment, context);
    expect(publicResponse.status).toBe(200);
    const publicBody = await publicResponse.json<{ itemsJson: string; readHead?: string }>();
    expect(JSON.parse(publicBody.itemsJson)).toEqual([expect.objectContaining({ status: "reserved" })]);
    expect(publicBody.readHead).toBe(queued.suid);

    const pass = await database.prepare(
      `SELECT status, coverage_kind, settled_frontier_suid,
              delivery_event_id, delivery_suid, delivery_attempt_id,
              catch_up_outcome, catch_up_result_json,
              safe_heads_before_json, safe_heads_after_json
         FROM serialized_dcb_safe_lane_passes
        WHERE service_id = ? AND trigger = 'kick' AND status = 'completed'
        ORDER BY scheduled_at DESC, pass_id DESC LIMIT 1`,
    ).bind(serviceId).first<Record<string, unknown>>();
    expect(pass).toMatchObject({
      status: "completed",
      coverage_kind: "SETTLED",
      settled_frontier_suid: queued.suid,
      delivery_event_id: queued.eventId,
      delivery_suid: queued.suid,
      delivery_attempt_id: queued.attemptId,
      catch_up_outcome: "completed",
    });
    expect(pass?.safe_heads_before_json).toBe("[]");
    expect(pass?.safe_heads_after_json).toContain(queued.suid);
    const observations = JSON.parse(String(pass?.catch_up_result_json)) as Array<{
      viewId: string;
      beforeSuid: string;
      afterSuid: string;
      safeWindowMs: number;
      advancedSourceEvents: number;
      appliedEvents: number;
      indeterminate: boolean;
    }>;
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        viewId: "ReservationProjector",
        beforeSuid: "",
        afterSuid: queued.suid,
        advancedSourceEvents: 1,
        appliedEvents: 1,
        indeterminate: false,
      }),
    ]));
    expect(observations.every((observation) => observation.safeWindowMs >= 20_000)).toBe(true);
  });

  it("AC4: cron-disabled Queue kick records the SafeWindow stop instead of claiming safe advancement", async () => {
    const database = (env as unknown as { D1?: D1Database }).D1;
    if (database === undefined) throw new Error("G67 requires the D1 pipeline binding");
    const serviceId = `g67-safewindow-${crypto.randomUUID()}`;
    const arrivedAt = Date.now();
    const queued = reservationDelivery(serviceId, arrivedAt);
    const source = new D1EventStore(database);
    await source.initialize();
    await expect(source.recordDelivery(queued, arrivedAt, "queue")).resolves.toMatchObject({ outcome: "stored" });
    const passEnvironment = {
      D1: database,
      D1_MV: mvDatabase(),
      TAG: sourceNamespace(queued),
      SDT_SERVICE_ID: serviceId,
    } as never;
    const waiters: Promise<void>[] = [];
    const context = { waitUntil: (promise: Promise<void>) => { waiters.push(promise); } } as never;
    scheduleMeetingRoomSafeLaneKick(passEnvironment, serviceId, context, undefined, {
      eventId: queued.eventId,
      suid: queued.suid,
      attemptId: queued.attemptId,
      partitionTag: queued.tag,
      obligationSequence: queued.completeness.obligationSequence,
    });
    await Promise.all(waiters);

    const views = new D1MaterializedViewStore(mvDatabase());
    await views.initialize();
    const safePage = await views.readListPage(serviceId, "ReservationProjector", { consistency: "safe", limit: null });
    expect(safePage.rows).toEqual([]);
    const pass = await database.prepare(
      `SELECT delivery_suid, catch_up_result_json, safe_heads_before_json,
              safe_heads_after_json
         FROM serialized_dcb_safe_lane_passes
        WHERE service_id = ? AND trigger = 'kick' AND status = 'completed'
        ORDER BY scheduled_at DESC, pass_id DESC LIMIT 1`,
    ).bind(serviceId).first<Record<string, unknown>>();
    expect(pass?.delivery_suid).toBe(queued.suid);
    expect(pass?.safe_heads_before_json).toBe("[]");
    expect(pass?.safe_heads_after_json).toContain('"head":""');
    const observations = JSON.parse(String(pass?.catch_up_result_json)) as Array<{
      afterSuid: string;
      safeWindowMs: number;
      advancedSourceEvents: number;
      appliedEvents: number;
      indeterminate: boolean;
    }>;
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ afterSuid: "", advancedSourceEvents: 0, appliedEvents: 0, indeterminate: false }),
    ]));
    expect(observations.every((observation) => observation.safeWindowMs >= 20_000)).toBe(true);
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

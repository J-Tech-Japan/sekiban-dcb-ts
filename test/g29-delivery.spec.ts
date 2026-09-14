import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type DeliveryViewHandler,
  preflightDirectDoorbell,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
} from "@sekiban/dcb-runtime";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { assertDeliveryMatrix } from "../scripts/g29-delivery-matrix.mjs";
import matrix from "../docs/SDT-G29-delivery-matrix.json";
import { deliveryPolicyFromDomain, type DomainViewDefinition } from "@sekiban/dcb-domain";
import { meetingRoomDomain } from "../samples/meeting-room/src/domain";
import { MeetingRoomDownstreamDoorbell, type MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-only";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message, g32StoredEvent } from "./helpers/g32-fixtures";

const views = [{ id: "RoomProjector" }, { id: "ReservationProjector" }];
const enabled = {
  DIRECT_DOORBELL: "true",
  DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector,ReservationProjector",
  DIRECT_DOORBELL_MAX_INVOCATIONS: "32",
};

// The per-view domain descriptor is the only policy source: each case supplies
// view declarations and the doorbell policy is derived from them.
const meetingRoomViews: readonly DomainViewDefinition[] = meetingRoomDomain.views;
const allQueuedViews: readonly DomainViewDefinition[] = meetingRoomViews.map((view) => ({ ...view, deliveryClass: "queued" as const }));
const meetingRoomPolicy = deliveryPolicyFromDomain(meetingRoomDomain);

function message(id: string): DownstreamOutboxMessage {
  return g32Message({
    serviceId: "g29-delivery-fixture",
    allocatorLineageId: "g29-delivery-lineage",
    tag: `room:${id}`,
    attemptId: `attempt-${id}`,
    eventId: `event-${id}`,
    suid: `suid-${id}`,
    payload: JSON.stringify({ roomId: id, name: "fixture" }),
    eventTags: [`room:${id}`],
    eventType: "RoomCreated",
    enqueuedAt: 0,
  });
}

function fakeStore(): PipelineStore {
  return {
    initialize: async () => undefined,
    recordDelivery: async (input, arrivedAt) => ({
      outcome: "stored",
      kind: "stored",
      event: g32StoredEvent(input, arrivedAt) satisfies StoredEvent,
    }),
    readAllEvents: async () => [],
    currentLagBound: async () => 0,
    projectDeliveryIncidents: async () => 0,
    upsertPending: async (input, firstObservedAt, lagBoundMs) => ({
      serviceId: input.serviceId,
      attemptId: input.attemptId,
      eventId: input.eventId,
      suid: input.suid,
      expectedPaths: [...input.eventTags],
      observedPaths: [...input.eventTags],
      firstObservedAt,
      lagBoundMs,
    }),
    listPending: async () => [],
    appendFinding: async () => undefined,
    hasFinding: async () => false,
    listFindings: async () => [],
    appendDeliveryIncident: async () => undefined,
    hasDeliveryIncident: async () => false,
    listDeliveryIncidents: async () => [],
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async () => ({ serviceId: "g29-delivery-fixture", projectionId: "fixture", tag: "room:fixture", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
  };
}

function spyViews(calls: string[]): readonly DeliveryViewHandler[] {
  return ["RoomProjector", "ReservationProjector"].map((id) => ({
    id,
    apply: async () => {
      calls.push(id);
      return "applied" as const;
    },
  }));
}

async function invokeDirect(env: MeetingRoomCloudflareEnv, id: string): Promise<void> {
  const receiver = new MeetingRoomDownstreamDoorbell(createExecutionContext(), env);
  await receiver.deliver(message(id));
}

async function invokeQueue(views: readonly DeliveryViewHandler[], id: string): Promise<void> {
  const batch = createMessageBatch("g29-delivery-fixture", [{ id, timestamp: new Date(), attempts: 1, body: message(id) }]);
  await handleDownstreamQueue(batch, {}, { store: fakeStore(), views });
  const outcome = await getQueueResult(batch, createExecutionContext());
  expect(outcome.explicitAcks).toHaveLength(1);
}

describe("SDT-G29 per-view delivery policy", () => {
  it("matches the published branch matrix against the real receiver and Queue entry points", async () => {
    const cases = {
      "immediate-enabled-allowed": { env: enabled, domain: "immediate-preferred" as const, domainViews: meetingRoomViews },
      "immediate-enabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "immediate-preferred" as const, domainViews: meetingRoomViews },
      "immediate-disabled-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false" }, domain: "immediate-preferred" as const, domainViews: meetingRoomViews },
      "immediate-disabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "immediate-preferred" as const, domainViews: meetingRoomViews },
      "queued-enabled-allowed": { env: enabled, domain: "queued" as const, domainViews: allQueuedViews },
      "queued-enabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "queued" as const, domainViews: allQueuedViews },
      "queued-disabled-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false" }, domain: "queued" as const, domainViews: allQueuedViews },
      "queued-disabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "queued" as const, domainViews: allQueuedViews },
    } as const;
    const actual = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([rowId, value]) => {
      const config = readDirectDoorbellConfig(value.env, value.domain, deliveryPolicyFromDomain({ views: value.domainViews }));
      const preflight = preflightDirectDoorbell(config);
      const status = preflight.status;
      const selected = status === "ready" ? selectDirectDoorbellViews(views, config).map((view) => view.id) : [];
      const queueInvocations = value.domain === "queued" || status === "queued-degraded" ? views.length : status === "ready" ? views.length - selected.length : 0;
      const directCalls: string[] = [];
      const queueCalls: string[] = [];
      if (status === "ready") {
        await invokeDirect({ ...value.env, SDT_SERVICE_ID: "g29-delivery-fixture", __G29_DOORBELL_TEST__: { store: fakeStore(), views: spyViews(directCalls), domainViews: value.domainViews, afterDelivery: async () => undefined } } as unknown as MeetingRoomCloudflareEnv, rowId);
      } else if (value.domain === "queued") {
        await invokeQueue(spyViews(queueCalls), rowId);
      }
      return [rowId, {
        descriptor: { domainClass: config.deliveryClass, viewClasses: config.domainViewDeliveryClasses },
        status,
        reason: preflight.reason,
        views: selected,
        directInvocations: directCalls.length,
        queueInvocations: queueCalls.length,
        expectedQueueInvocations: queueInvocations,
      }];
    })));
    for (const value of Object.values(actual) as Array<{ readonly queueInvocations: number; readonly expectedQueueInvocations: number }>) expect(value.queueInvocations).toBe(value.expectedQueueInvocations);
    expect(assertDeliveryMatrix(actual, matrix)).toEqual({ rows: 8 });
  });

  it("keeps the C3 Room-only/Reservation-queued regression visible through MeetingRoomDownstreamDoorbell.deliver", async () => {
    const directCalls: string[] = [];
    const queueCalls: string[] = [];
    const domainViews = meetingRoomViews.map((view) => ({ ...view, deliveryClass: view.id === "RoomProjector" ? "immediate-preferred" as const : "queued" as const }));
    await invokeDirect({ ...enabled, SDT_SERVICE_ID: "g29-c3-regression", __G29_DOORBELL_TEST__: { store: fakeStore(), views: spyViews(directCalls), domainViews, afterDelivery: async () => undefined } } as unknown as MeetingRoomCloudflareEnv, "c3-regression");
    await invokeQueue(spyViews(queueCalls).filter((view) => view.id === "ReservationProjector"), "c3-regression-queue");
    expect(directCalls).toEqual(["RoomProjector"]);
    expect(directCalls).not.toContain("ReservationProjector");
    expect(queueCalls).toEqual(["ReservationProjector"]);
  });

  it("emits a bounded sdt.observe/v1 barrier lifecycle from the existing in-process doorbell seam", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      const delivery = invokeDirect({
        ...enabled,
        SDT_SERVICE_ID: "g30-doorbell-observation",
        __G29_DOORBELL_TEST__: {
          store: fakeStore(),
          views: spyViews([]),
          afterDelivery: async () => undefined,
          faultBarrier: {
            barrierId: "g30-fixture-doorbell",
            boundedWindowMs: 100,
            waitForRelease: () => held,
          },
        },
      } as unknown as MeetingRoomCloudflareEnv, "g30-doorbell-observation");
      await Promise.resolve();
      release();
      await delivery;
      const stages = consoleLog.mock.calls
        .map(([entry]) => entry)
        .filter((entry): entry is { schema: string; event: string; barrierId: string; stage: string } =>
          typeof entry === "object" && entry !== null
          && (entry as { schema?: unknown }).schema === "sdt.observe/v1"
          && (entry as { event?: unknown }).event === "fault.barrier",
        )
        .filter((entry) => entry.barrierId === "g30-fixture-doorbell")
        .map((entry) => entry.stage);
      expect(stages).toEqual(["started", "ended", "drained"]);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("keeps the deployment global class subordinate to the per-view descriptor", () => {
    const config = readDirectDoorbellConfig({
      ...enabled,
      DOMAIN_DELIVERY_CLASS: "queued",
    }, "immediate-preferred", meetingRoomPolicy);
    expect(config.deliveryClass).toBe("immediate-preferred");
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("keeps descriptor-absent legacy migration explicit", () => {
    const config = readDirectDoorbellConfig({ ...enabled, DOMAIN_DELIVERY_CLASS: "immediate-preferred" });
    expect(config.domainViewDeliveryClasses).toBeUndefined();
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("does not silently degrade the queued-degraded branch", () => {
    const config = readDirectDoorbellConfig({ ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_DEGRADATION: "queued-degraded" }, "immediate-preferred", meetingRoomPolicy);
    expect(preflightDirectDoorbell(config)).toMatchObject({ status: "queued-degraded", reason: "deployment_direct_doorbell_disabled" });
    expect(selectDirectDoorbellViews(views, config)).toEqual([]);
  });

  it("turns a changed view policy into an exact matrix failure", () => {
    const config = readDirectDoorbellConfig(enabled, "immediate-preferred", {
      RoomProjector: "immediate-preferred",
      ReservationProjector: "immediate-preferred",
    });
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("SDT-G88 AC7: derives the sample doorbell policy from the domain view descriptors", () => {
    expect(meetingRoomPolicy).toEqual(matrix.descriptor);
    expect(Object.keys(meetingRoomPolicy)).toEqual(meetingRoomDomain.views.map((view) => view.id));
    expect(meetingRoomDomain.views.map((view) => view.deliveryClass)).toEqual(Object.values(matrix.descriptor));
  });
});

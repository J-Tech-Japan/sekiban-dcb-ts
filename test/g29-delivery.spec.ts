import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
import { meetingRoomDeliveryPolicy } from "../samples/meeting-room/src/domain";
import { MeetingRoomDownstreamDoorbell, type MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-only";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message, g32StoredEvent } from "./helpers/g32-fixtures";

const views = [{ id: "RoomProjector" }, { id: "ReservationProjector" }];
const enabled = {
  DIRECT_DOORBELL: "true",
  DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector,ReservationProjector",
  DIRECT_DOORBELL_MAX_INVOCATIONS: "32",
};

const allQueued = { RoomProjector: "queued" as const, ReservationProjector: "queued" as const };

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
      "immediate-enabled-allowed": { env: enabled, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "immediate-enabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "immediate-disabled-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false" }, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "immediate-disabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "queued-enabled-allowed": { env: enabled, domain: "queued" as const, policy: allQueued },
      "queued-enabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "queued" as const, policy: allQueued },
      "queued-disabled-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false" }, domain: "queued" as const, policy: allQueued },
      "queued-disabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "queued" as const, policy: allQueued },
    } as const;
    const actual = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([rowId, value]) => {
      const config = readDirectDoorbellConfig(value.env, value.domain, value.policy);
      const preflight = preflightDirectDoorbell(config);
      const status = preflight.status;
      const selected = status === "ready" ? selectDirectDoorbellViews(views, config).map((view) => view.id) : [];
      const queueInvocations = value.domain === "queued" || status === "queued-degraded" ? views.length : status === "ready" ? views.length - selected.length : 0;
      const directCalls: string[] = [];
      const queueCalls: string[] = [];
      if (status === "ready") {
        await invokeDirect({ ...value.env, SDT_SERVICE_ID: "g29-delivery-fixture", __G29_DOORBELL_TEST__: { store: fakeStore(), views: spyViews(directCalls), deliveryPolicy: value.policy, afterDelivery: async () => undefined } } as unknown as MeetingRoomCloudflareEnv, rowId);
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
    const policy = { RoomProjector: "immediate-preferred" as const, ReservationProjector: "queued" as const };
    await invokeDirect({ ...enabled, SDT_SERVICE_ID: "g29-c3-regression", __G29_DOORBELL_TEST__: { store: fakeStore(), views: spyViews(directCalls), deliveryPolicy: policy, afterDelivery: async () => undefined } } as unknown as MeetingRoomCloudflareEnv, "c3-regression");
    await invokeQueue(spyViews(queueCalls).filter((view) => view.id === "ReservationProjector"), "c3-regression-queue");
    expect(directCalls).toEqual(["RoomProjector"]);
    expect(directCalls).not.toContain("ReservationProjector");
    expect(queueCalls).toEqual(["ReservationProjector"]);
  });

  it("keeps the deployment global class subordinate to the per-view descriptor", () => {
    const config = readDirectDoorbellConfig({
      ...enabled,
      DOMAIN_DELIVERY_CLASS: "queued",
    }, "immediate-preferred", meetingRoomDeliveryPolicy);
    expect(config.deliveryClass).toBe("immediate-preferred");
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("keeps descriptor-absent legacy migration explicit", () => {
    const config = readDirectDoorbellConfig({ ...enabled, DOMAIN_DELIVERY_CLASS: "immediate-preferred" });
    expect(config.domainViewDeliveryClasses).toBeUndefined();
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("does not silently degrade the queued-degraded branch", () => {
    const config = readDirectDoorbellConfig({ ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_DEGRADATION: "queued-degraded" }, "immediate-preferred", meetingRoomDeliveryPolicy);
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
});

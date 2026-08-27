import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processDownstreamDoorbell, type DeliveryViewHandler } from "@sekiban/dcb-runtime/cloudflare";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import receiverModule, { MeetingRoomDownstreamDoorbell } from "../samples/meeting-room/src/worker.g38-receiver";
import primaryWorker from "../samples/meeting-room/src/worker.cloudflare-only";
import { rejectUnlessPrimaryComponent } from "../samples/meeting-room/src/worker.g38-component-guard";
import type { MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-env";
import { g32Message, g32StoredEvent } from "./helpers/g32-fixtures";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

function message(id: string): DownstreamOutboxMessage {
  return g32Message({
    serviceId: "g38-receiver-fixture",
    allocatorLineageId: "g38-receiver-lineage",
    tag: `room:${id}`,
    attemptId: `attempt-${id}`,
    eventId: `event-${id}`,
    suid: `63891696000000000000000000001`,
    payload: JSON.stringify({ roomId: id, name: "fixture" }),
    eventTags: [`room:${id}`],
    eventType: "RoomCreated",
    enqueuedAt: 0,
  });
}

function fakeStore(onInitialize?: () => void): PipelineStore {
  return {
    initialize: async () => { onInitialize?.(); },
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
    projectionLag: async () => ({ serviceId: "g38-receiver-fixture", projectionId: "fixture", tag: "room:fixture", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
  };
}

function bootstrapAccepting(): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => "bootstrap" }) as DurableObjectId,
    get: () => ({ fetch: async () => new Response(null, { status: 200 }) }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function selectedViews(calls: string[]): readonly DeliveryViewHandler[] {
  return [{
    id: "RoomProjector",
    apply: async () => {
      calls.push("RoomProjector");
      return "applied" as const;
    },
  }];
}

describe("SDT-G38 receiver-only surface preparation", () => {
  it("exports only the named doorbell entrypoint plus a module-format empty default handler", () => {
    expect(Object.keys(receiverModule)).toEqual([]);
    expect("fetch" in receiverModule).toBe(false);
    expect("queue" in receiverModule).toBe(false);
    expect("scheduled" in receiverModule).toBe(false);
    expect(MeetingRoomDownstreamDoorbell).toEqual(expect.any(Function));
  });

  it("keeps the named receiver delivery entrypoint permitted through the external bootstrap authority", async () => {
    const calls: string[] = [];
    const env = {
      BOOTSTRAP: bootstrapAccepting(),
      G38_DOORBELL_DELIVERY_ROLE: "receiver",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector",
      DIRECT_DOORBELL_MAX_INVOCATIONS: "32",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
      SDT_SERVICE_ID: "g38-receiver-fixture",
      __G29_DOORBELL_TEST__: { store: fakeStore(), views: selectedViews(calls), afterDelivery: async () => undefined },
    } as unknown as MeetingRoomCloudflareEnv;
    const receiver = new MeetingRoomDownstreamDoorbell(createExecutionContext(), env);
    const result = await receiver.deliver(message("permitted"));
    expect(result.fastDisposition).toBe("completed");
    expect(calls).toEqual(["RoomProjector"]);
  });

  it("fails a receiver delivery before store initialization when its external BOOTSTRAP binding is absent", async () => {
    let storeInitializations = 0;
    await expect(processDownstreamDoorbell(message("missing-bootstrap"), {
      G38_DOORBELL_DELIVERY_ROLE: "receiver",
    }, {
      store: fakeStore(() => { storeInitializations += 1; }),
      views: selectedViews([]),
    })).rejects.toThrow("bootstrap_route_binding_missing:fast");
    expect(storeInitializations).toBe(0);
  });

  it.each(["receiver", undefined, "unknown"] as const)("rejects the four primary-only entries for component %s before any port call", async (component) => {
    const portNames = new Set(["BOOTSTRAP", "ALLOCATOR", "JOURNAL", "TAG", "D1", "D1_MV", "DOWNSTREAM_QUEUE"]);
    let portCalls = 0;
    const env = new Proxy({ G32_COMPONENT: component, CONFORMANCE_TOKEN: "fixture" }, {
      get(target, property, receiver) {
        if (typeof property === "string" && portNames.has(property)) {
          portCalls += 1;
          throw new Error(`unexpected port access: ${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as MeetingRoomCloudflareEnv;
    const ctx = createExecutionContext();
    const requests = [
      new Request("https://g38.test/api/commands/create-room", { method: "POST", body: "{}" }),
      new Request("https://g38.test/operator/bootstrap/g38-receiver-fixture/status"),
      new Request("https://g38.test/operator/repair", { method: "POST", body: "{}" }),
      new Request("https://g38.test/conformance/v1/api/sekiban/serialized/commit", { headers: { authorization: "Bearer fixture" } }),
    ];
    for (const request of requests) {
      const response = await primaryWorker.fetch!(request as never, env, ctx);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "This route is available only on the primary component",
        code: "g38_primary_component_required",
      });
    }
    expect(portCalls).toBe(0);
  });

  it("keeps primary as the only component admitted by the guard", () => {
    expect(rejectUnlessPrimaryComponent({ G32_COMPONENT: "primary" }, "command")).toBeUndefined();
  });

  it("rejects a conformance runtime-control suffix before it reaches a runtime or port", async () => {
    let portCalls = 0;
    const env = new Proxy({ G32_COMPONENT: "primary", CONFORMANCE_TOKEN: "fixture" }, {
      get(target, property, receiver) {
        if (["BOOTSTRAP", "ALLOCATOR", "JOURNAL", "TAG", "D1", "D1_MV", "DOWNSTREAM_QUEUE"].includes(String(property))) {
          portCalls += 1;
          throw new Error(`unexpected port access: ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as MeetingRoomCloudflareEnv;
    const response = await primaryWorker.fetch!(new Request("https://g38.test/conformance/v1/internal/downstream/drain", {
      method: "POST",
      headers: { authorization: "Bearer fixture" },
    }) as never, env, createExecutionContext());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Conformance route is not allowlisted",
      code: "conformance_route_not_allowed",
    });
    expect(portCalls).toBe(0);
  });
});

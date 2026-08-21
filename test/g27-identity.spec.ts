import { describe, expect, it } from "vitest";
import {
  canonicalEventKey,
  defineEvent,
  defineProjector,
  parseCanonicalEventKey,
} from "@sekiban/dcb-core";
import { validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import {
  allocateOrderRange,
  ORDER_SUID_LIMIT,
} from "../packages/dcb-runtime/src/allocator/OrderClock";
import { resolveDeliveryIdentity, MissingCanonicalEventIdentityError } from "../packages/dcb-runtime/src/eventIdentity";
import { processDeliveryCore } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import { isDownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";

function tagStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectTransaction;
  return {
    get: transaction.get,
    put: transaction.put,
    delete: transaction.delete,
    deleteAll: async () => { values.clear(); },
    list: transaction.list,
    setAlarm: transaction.setAlarm,
    deleteAlarm: transaction.deleteAlarm,
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => callback(transaction),
  } as unknown as DurableObjectStorage;
}

describe("SDT-G27 canonical event identity", () => {
  it("rejects ambiguous names and accepts only canonical decimal versions", () => {
    expect(canonicalEventKey("OrderPlaced")).toBe("OrderPlaced:1");
    expect(canonicalEventKey("OrderPlaced", 2)).toBe("OrderPlaced:2");
    expect(parseCanonicalEventKey("OrderPlaced:2")).toMatchObject({ eventPayloadName: "OrderPlaced", version: 2, key: "OrderPlaced:2" });
    expect(() => canonicalEventKey("Order:Placed")).toThrow(/must not contain/);
    expect(() => parseCanonicalEventKey("OrderPlaced:02")).toThrow(/canonical/);
    expect(() => parseCanonicalEventKey("OrderPlaced:1:2")).toThrow();
  });

  it("assigns identity at commit admission without changing the V1 response contract", async () => {
    const accepted = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced", tags: ["orders"] }],
      consistencyTags: [],
    });
    expect("value" in accepted && accepted.value.eventCandidates[0]?.eventType).toBe("OrderPlaced:1");
    const rejected = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "Order:Placed", tags: ["orders"] }],
      consistencyTags: [],
    });
    expect("error" in rejected ? rejected.error.status : 200).toBe(400);
  });

  it("retains the exact identity through Tag durable event and pending outbox envelope", async () => {
    const storage = tagStorage();
    const waits: Promise<unknown>[] = [];
    const ctx = { storage, waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as DurableObjectState;
    const tagObject = new TagDurableObject(ctx, {} as never);
    const tag = "orders:g27";
    const eventType = "OrderPlaced:2";
    const append = await tagObject.fetch(new Request(`https://g27.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g27-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "g27-attempt",
        epoch: 0,
        candidates: [{ eventId: "g27-event", suid: "suid-00000000000000000000000000000001", payload: "e30=", eventType, provenance: "g27", eventTags: [tag], allocatorLineageId: "g27-lineage" }],
      }),
    }));
    expect(append.status).toBe(201);
    expect(waits).toHaveLength(0);
    const pending = await tagObject.fetch(new Request(`https://g27.test/outbox/pending?__tag=${encodeURIComponent(tag)}&__serviceId=g27-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowMs: 100 }),
    }));
    const body = await pending.json<{ rows: DownstreamOutboxMessage[] }>();
    expect(pending.status).toBe(200);
    expect(body.rows[0]).toMatchObject({ eventType, provenance: "g27", eventId: "g27-event" });
    expect(resolveDeliveryIdentity(body.rows[0]!, "queue")).toMatchObject({ key: eventType, legacy: false });
    expect(() => resolveDeliveryIdentity({ provenance: "g27" }, "fast")).toThrow(MissingCanonicalEventIdentityError);
    expect(() => resolveDeliveryIdentity({}, "queue")).toThrow(MissingCanonicalEventIdentityError);
    expect(resolveDeliveryIdentity({ provenance: "pre-g27-queue" }, "queue")).toMatchObject({ legacy: true, key: "__legacy__:1" });
    expect(isDownstreamOutboxMessage({ ...body.rows[0], eventType: "Order:2:3" })).toBe(false);
  });

  it("carries canonical identity from delivery admission into the StoredEvent callback", async () => {
    const message: DownstreamOutboxMessage = {
      version: 1,
      serviceId: "g27-core-service",
      allocatorLineageId: "g27-core-lineage",
      tag: "orders:g27-core",
      attemptId: "g27-core-attempt",
      eventId: "g27-core-event",
      suid: "suid-00000000000000000000000000000002",
      payload: "e30=",
      eventTags: ["orders:g27-core"],
      eventType: "OrderPlaced:2",
      provenance: "g27",
      enqueuedAt: 0,
    };
    let storedIdentity: { eventType?: string; provenance?: string } | undefined;
    const pending = {
      serviceId: message.serviceId,
      attemptId: message.attemptId,
      eventId: message.eventId,
      suid: message.suid,
      expectedPaths: message.eventTags,
      observedPaths: message.eventTags,
      firstObservedAt: 1,
      lagBoundMs: 20_000,
    };
    const store = {
      initialize: async () => {},
      recordDelivery: async () => ({
        outcome: "stored",
        kind: "stored",
        event: {
          serviceId: message.serviceId,
          eventId: message.eventId,
          suid: message.suid,
          payload: message.payload,
          eventTags: message.eventTags,
          firstArrivedAt: 1,
          lastArrivedAt: 1,
          maxDeliveryLagMs: 1,
          arrivals: [],
        },
      }),
      currentLagBound: async () => 0,
      upsertPending: async () => pending,
      listPending: async () => [],
      appendFinding: async () => {},
      hasFinding: async () => false,
      listFindings: async () => [],
      appendDeliveryIncident: async () => {},
      hasDeliveryIncident: async () => false,
      listDeliveryIncidents: async () => [],
      readAllEvents: async () => [],
      listProjectionTags: async () => [],
      readProjectionCheckpoint: async () => undefined,
      advanceProjectionCheckpoint: async () => false,
      projectionLag: async () => ({ serviceId: message.serviceId, projectionId: "g27", tag: message.tag, checkpointSuid: "", headSuid: message.suid, behindEvents: 0 }),
    } as unknown as PipelineStore;
    const outcome = await processDeliveryCore(message, "queue", {}, {
      store,
      onStored: async ({ event }) => { storedIdentity = { eventType: event.eventType, provenance: event.provenance }; },
    });
    expect(outcome.outcome).toBe("stored");
    expect(storedIdentity).toEqual({ eventType: "OrderPlaced:2", provenance: "g27" });
  });

  it("dispatches same-name versions by registry identity and never by payload sniffing", () => {
    const v1 = defineEvent({ name: "Order", version: 1 });
    const v2 = defineEvent({ name: "Order", version: 2 });
    const projector = defineProjector({
      id: "g27-projector",
      events: [v1, v2],
      initialState: [] as string[],
      eventTypeHandlers: {
        "Order:1": (state, event) => [...state, `v1:${JSON.stringify(event.payload)}`],
        "Order:2": (state, event) => [...state, `v2:${JSON.stringify(event.payload)}`],
      },
    });
    expect(projector.apply([], { eventType: "Order:1", payload: { eventType: "wrong" } })).toEqual(["v1:{\"eventType\":\"wrong\"}"]);
    expect(projector.apply([], { eventType: "Order:2", payload: { eventType: "wrong" } })).toEqual(["v2:{\"eventType\":\"wrong\"}"]);
    expect(() => projector.apply([], { eventType: "Order:3", payload: {} })).toThrow(/canonical|subscribe|handler/i);
  });

  it("uses one monotone OrderClock range with watermark floor and typed overflow", () => {
    const first = allocateOrderRange(null, 2, 10n);
    expect(first.suids).toEqual([
      "suid-00000000000000000000000000000010",
      "suid-00000000000000000000000000000011",
    ]);
    const afterRollback = allocateOrderRange(first.watermark, 2, 5n);
    expect(afterRollback.base).toBe(12n);
    expect(afterRollback.suids[0]).toBe("suid-00000000000000000000000000000012");
    expect(() => allocateOrderRange(null, 2, ORDER_SUID_LIMIT - 1n)).toThrow(/exhausted|domain/i);
  });
});

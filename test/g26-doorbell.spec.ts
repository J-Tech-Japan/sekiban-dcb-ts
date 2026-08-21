import { describe, expect, it } from "vitest";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

function tagStorage(): { readonly storage: DurableObjectStorage; readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectTransaction;
  const storage = {
    get: transaction.get,
    put: transaction.put,
    delete: transaction.delete,
    deleteAll: async () => { values.clear(); },
    list: transaction.list,
    setAlarm: transaction.setAlarm,
    deleteAlarm: transaction.deleteAlarm,
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => callback(transaction),
  } as unknown as DurableObjectStorage;
  return { storage, values };
}

describe("SDT-G26 Tag doorbell handoff", () => {
  it("builds one complete pending envelope and hands identical bytes to doorbell and Queue after response", async () => {
    const { storage } = tagStorage();
    const waits: Promise<unknown>[] = [];
    const doorbell: DownstreamOutboxMessage[] = [];
    const queue: DownstreamOutboxMessage[] = [];
    const ctx = {
      storage,
      waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
    } as unknown as DurableObjectState;
    const instance = new TagDurableObject(ctx, {
      AUTO_DRAIN_OUTBOX: "true",
      DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
      DOWNSTREAM_DOORBELL: {
        deliver: async (message: DownstreamOutboxMessage) => {
          doorbell.push(message);
          return { fastDisposition: "completed" };
        },
      },
      DOWNSTREAM_QUEUE: {
        send: async (message: DownstreamOutboxMessage) => { queue.push(message); return {}; },
      },
    } as never);
    const serviceId = "g26-doorbell-service";
    const tag = "reservation:g26-doorbell";
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${serviceId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g26-attempt",
          epoch: 0,
          candidates: [{
            eventId: "g26-event",
            suid: "g26-suid",
            payload: btoa(JSON.stringify({ eventType: "G26" })),
            eventTags: [tag],
            allocatorLineageId: "g26-lineage",
          }],
        }),
      },
    ));
    expect(response.status).toBe(201);
    // The service-binding call is not allowed to run as part of the append
    // response. It is owned by the DO waitUntil lifetime.
    expect(doorbell).toEqual([]);
    expect(queue).toEqual([]);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(doorbell).toHaveLength(1);
    expect(queue).toHaveLength(1);
    expect(JSON.stringify(doorbell[0])).toBe(JSON.stringify(queue[0]));
    expect(doorbell[0]).toMatchObject({
      version: 1,
      serviceId,
      tag,
      eventTags: [tag],
      enqueuedAt: expect.any(Number),
      allocatorLineageId: "g26-lineage",
    });
  });
});

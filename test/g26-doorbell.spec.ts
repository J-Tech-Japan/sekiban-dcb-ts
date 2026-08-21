import { describe, expect, it, vi } from "vitest";
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
      DOMAIN_DELIVERY_CLASS: "immediate-preferred",
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

  it("emits the exact envelope-bound correlation id on fast success, failure, and degradation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const append = async (suffix: string, binding: unknown, degraded = false, domainDeliveryClass?: "immediate-preferred" | "queued") => {
      const { storage } = tagStorage();
      const waits: Promise<unknown>[] = [];
      const ctx = { storage, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as unknown as DurableObjectState;
      const env: Record<string, unknown> = {
        AUTO_DRAIN_OUTBOX: "true",
        DOMAIN_DELIVERY_CLASS: "immediate-preferred",
        DIRECT_DOORBELL: "true",
        DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
        DIRECT_DOORBELL_DEGRADATION: "queued-degraded",
        DOWNSTREAM_QUEUE: { send: async () => ({}) },
      };
      if (!degraded) env.DOWNSTREAM_DOORBELL = binding;
      const instance = new TagDurableObject(ctx, env as never);
      const serviceId = `g26-correlation-${suffix}`;
      const tag = `reservation:${suffix}`;
      const eventId = `g26-event-${suffix}`;
      const attemptId = `g26-attempt-${suffix}`;
      const appendUrl = new URL(`https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${serviceId}`);
      if (domainDeliveryClass !== undefined) appendUrl.searchParams.set("__domainDeliveryClass", domainDeliveryClass);
      const response = await instance.fetch(new Request(
        appendUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attemptId,
            epoch: 0,
            candidates: [{
              eventId,
              suid: `g26-suid-${suffix}`,
              payload: btoa(JSON.stringify({ eventType: "G26" })),
              eventTags: [tag],
              allocatorLineageId: `g26-lineage-${suffix}`,
            }],
          }),
        },
      ));
      expect(response.status).toBe(201);
      await Promise.all(waits);
      return { correlationId: `fast:${serviceId}:${eventId}:${attemptId}` };
    };

    const success = await append("success", { deliver: async () => ({ fastDisposition: "completed", correlationId: "fast:g26-correlation-success:g26-event-success:g26-attempt-success" }) });
    const failure = await append("failure", { deliver: async () => { throw new Error("receiver timeout"); } });
    const degraded = await append("degraded", undefined, true);

    const logCalls = log.mock.calls.map(([, value]) => value as { correlationId?: string; envelopeBytes?: string });
    const warnCalls = warn.mock.calls.map(([, value]) => value as { correlationId?: string; envelopeBytes?: string });
    expect(logCalls.find((value) => value.correlationId === success.correlationId)?.envelopeBytes).toEqual(expect.any(String));
    expect(warnCalls.filter((value) => value.correlationId === failure.correlationId)).toHaveLength(1);
    expect(warnCalls.filter((value) => value.correlationId === degraded.correlationId)).toHaveLength(1);
    expect(warnCalls.find((value) => value.correlationId === failure.correlationId)?.envelopeBytes).toEqual(expect.any(String));
    expect(warnCalls.find((value) => value.correlationId === degraded.correlationId)?.envelopeBytes).toEqual(expect.any(String));
    log.mockRestore();
    warn.mockRestore();
  });

  it("uses the domain delivery class forwarded by the runtime when deciding whether Tag fires", async () => {
    const { storage } = tagStorage();
    const waits: Promise<unknown>[] = [];
    let directCalls = 0;
    const ctx = { storage, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as unknown as DurableObjectState;
    const instance = new TagDurableObject(ctx, {
      AUTO_DRAIN_OUTBOX: "true",
      DOMAIN_DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
      DOWNSTREAM_DOORBELL: { deliver: async () => { directCalls += 1; return { fastDisposition: "completed" }; } },
      DOWNSTREAM_QUEUE: { send: async () => ({}) },
    } as never);
    const tag = "reservation:g26-domain-forwarded";
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g26-domain-forwarded&__domainDeliveryClass=queued`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g26-domain-attempt",
          epoch: 0,
          candidates: [{
            eventId: "g26-domain-event",
            suid: "g26-domain-suid",
            payload: btoa(JSON.stringify({ eventType: "G26" })),
            eventTags: [tag],
            allocatorLineageId: "g26-domain-lineage",
          }],
        }),
      },
    ));
    expect(response.status).toBe(201);
    await Promise.all(waits);
    expect(directCalls).toBe(0);
  });

  it("returns an observed fail-fast result before a capability-less direct append is committed", async () => {
    const { storage } = tagStorage();
    const waits: Promise<unknown>[] = [];
    const ctx = { storage, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as unknown as DurableObjectState;
    const instance = new TagDurableObject(ctx, {
      AUTO_DRAIN_OUTBOX: "true",
      DOMAIN_DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
      DOWNSTREAM_QUEUE: { send: async () => ({}) },
    } as never);
    const tag = "reservation:g26-fail-fast";
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g26-fail-fast`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g26-fail-fast-attempt",
          epoch: 0,
          candidates: [{
            eventId: "g26-fail-fast-event",
            suid: "g26-fail-fast-suid",
            payload: btoa(JSON.stringify({ eventType: "G26" })),
            eventTags: [tag],
            allocatorLineageId: "g26-fail-fast-lineage",
          }],
        }),
      },
    ));
    expect(response.status).toBe(500);
    expect(waits).toHaveLength(0);
  });
});

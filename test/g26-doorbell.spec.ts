import { describe, expect, it, vi } from "vitest";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message } from "./helpers/g32-fixtures";

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

function candidate(
  serviceId: string,
  tag: string,
  attemptId: string,
  eventId: string,
  suid: string,
  allocatorLineageId: string,
): Pick<DownstreamOutboxMessage, "eventId" | "suid" | "payload" | "eventTags" | "eventType" | "provenance" | "timestamp" | "allocatorLineageId"> {
  const envelope = g32Message({
    serviceId,
    tag,
    attemptId,
    eventId,
    suid,
    payload: JSON.stringify({ eventType: "G26" }),
    eventTags: [tag],
    eventType: "G26",
    allocatorLineageId,
  });
  return {
    eventId: envelope.eventId,
    suid: envelope.suid,
    payload: envelope.payload,
    eventTags: envelope.eventTags,
    eventType: envelope.eventType,
    provenance: envelope.provenance,
    timestamp: envelope.timestamp,
    allocatorLineageId: envelope.allocatorLineageId,
  };
}

describe("SDT-G26 Tag doorbell handoff", () => {
  it("builds one complete pending envelope and starts the handoff before response retention", async () => {
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
    const appendCandidate = candidate(serviceId, tag, "g26-attempt", "g26-event", "g26-suid", "g26-lineage");
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${serviceId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g26-attempt",
          epoch: 0,
          candidates: [appendCandidate],
        }),
      },
    ));
    expect(response.status).toBe(201);
    // The durable append is complete before the handoff starts. The returned
    // promise is still retained by the DO waitUntil lifetime while the
    // transport work runs outside the storage transaction.
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
      const appendCandidate = candidate(serviceId, tag, attemptId, eventId, `g26-suid-${suffix}`, `g26-lineage-${suffix}`);
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
            candidates: [appendCandidate],
          }),
        },
      ));
      expect(response.status).toBe(201);
      await Promise.all(waits);
      return { correlationId: `fast:${serviceId}:${appendCandidate.eventId}:${attemptId}` };
    };

    const success = await append("success", {
      deliver: async (message: DownstreamOutboxMessage) => ({
        fastDisposition: "completed",
        correlationId: `fast:${message.serviceId}:${message.eventId}:${message.attemptId}`,
      }),
    });
    const failure = await append("failure", { deliver: async () => { throw new Error("receiver timeout"); } });
    const degraded = await append("degraded", undefined, true);

    // G30 may emit its independent structured observation as a one-argument
    // console event while this fixture is exercising G26's two-argument
    // doorbell diagnostics.  Only inspect the latter; unrelated telemetry
    // must not make the correlation oracle throw before it can assert.
    const diagnosticObject = (value: unknown): value is { correlationId?: string; envelopeBytes?: string } =>
      value !== null && typeof value === "object";
    const logCalls = log.mock.calls.map(([, value]) => value).filter(diagnosticObject);
    const warnCalls = warn.mock.calls.map(([, value]) => value).filter(diagnosticObject);
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
    const appendCandidate = candidate("g26-domain-forwarded", tag, "g26-domain-attempt", "g26-domain-event", "g26-domain-suid", "g26-domain-lineage");
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g26-domain-forwarded&__domainDeliveryClass=queued`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g26-domain-attempt",
          epoch: 0,
          candidates: [appendCandidate],
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
    const appendCandidate = candidate("g26-fail-fast", tag, "g26-fail-fast-attempt", "g26-fail-fast-event", "g26-fail-fast-suid", "g26-fail-fast-lineage");
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g26-fail-fast`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g26-fail-fast-attempt",
          epoch: 0,
          candidates: [appendCandidate],
        }),
      },
    ));
    expect(response.status).toBe(500);
    expect(waits).toHaveLength(0);
  });
});

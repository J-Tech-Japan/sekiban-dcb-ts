import { describe, expect, it } from "vitest";
import {
  canonicalEventKey,
  defineDomain,
  defineEvent,
  defineProjector,
  parseCanonicalEventKey,
} from "@sekiban/dcb-core";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import {
  MissingCanonicalEventIdentityError,
  resolveDeliveryIdentity,
} from "../packages/dcb-runtime/src/eventIdentity";
import { processDeliveryCore } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import { downstreamEnvelopeBytes } from "../packages/dcb-runtime/src/downstream/Doorbell";
import { isDownstreamOutboxMessage, type DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";

/** The filename is retained so the G27-to-G32 cutover regression remains in CI. */
function tagStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => { values.delete(key); },
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

function storedEvent(message: DownstreamOutboxMessage): StoredEvent {
  return {
    serviceId: message.serviceId,
    id: message.eventId,
    eventId: message.eventId,
    sortableUniqueId: message.suid,
    suid: message.suid,
    payload: message.payload,
    tags: [...message.eventTags],
    eventTags: [...message.eventTags],
    eventType: message.eventType,
    timestamp: message.timestamp,
    causationId: message.causationId,
    correlationId: message.correlationId,
    executedUser: message.executedUser,
    provenance: "g32",
    firstArrivedAt: 1,
    lastArrivedAt: 1,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

function coreStore(message: DownstreamOutboxMessage, onRecord: () => void): PipelineStore {
  const pending = {
    serviceId: message.serviceId,
    attemptId: message.attemptId,
    eventId: message.eventId,
    suid: message.suid,
    expectedPaths: [...message.eventTags],
    observedPaths: [message.tag],
    firstObservedAt: 1,
    lagBoundMs: 20_000,
  };
  return {
    initialize: async () => {},
    recordDelivery: async () => {
      onRecord();
      return { outcome: "stored", kind: "stored", event: storedEvent(message) };
    },
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
    projectionLag: async () => ({ serviceId: message.serviceId, projectionId: "g32", tag: message.tag, checkpointSuid: "", headSuid: message.suid, behindEvents: 0 }),
  } as PipelineStore;
}

describe("SDT-G32 retained identity cutover regression", () => {
  it("uses the event payload name as the sole durable EventType and rejects versions", () => {
    expect(canonicalEventKey("OrderPlaced")).toBe("OrderPlaced");
    expect(parseCanonicalEventKey("OrderPlaced")).toMatchObject({ eventPayloadName: "OrderPlaced", key: "OrderPlaced" });
    expect(() => canonicalEventKey("Order:Placed")).toThrow(/must not contain/i);
    expect(() => parseCanonicalEventKey("OrderPlaced:2")).toThrow(/must not contain|canonical/i);

    const accepted = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced", tags: ["orders:one"] }],
      consistencyTags: [],
    });
    expect("value" in accepted && accepted.value.eventCandidates[0]?.eventType).toBe("OrderPlaced");

    const versioned = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced", eventPayloadVersion: 2, tags: ["orders:one"] }],
      consistencyTags: [],
    });
    const colonName = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced:2", tags: ["orders:one"] }],
      consistencyTags: [],
    });
    expect("error" in versioned && versioned.error.status).toBe(400);
    expect("error" in colonName && colonName.error.status).toBe(400);
  });

  it("keeps EventType, UUID v7, and 30-digit SUID mutually independent", () => {
    const message = g32Message({
      serviceId: "g32-identity",
      tag: "orders:independent",
      eventId: "independent-event",
      suid: "independent-suid",
      payload: JSON.stringify({ value: "kept" }),
      eventType: "OrderPlaced",
    });
    const identity = resolveDeliveryIdentity(message, "queue");
    expect(identity).toMatchObject({ key: "OrderPlaced", eventPayloadName: "OrderPlaced", provenance: "g32", legacy: false });
    expect(message.eventId).not.toBe(message.eventType);
    expect(message.suid).not.toBe(message.eventType);
    expect(message.eventId).not.toBe(message.suid);
    expect(message.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(message.suid).toMatch(/^\d{30}$/);
  });

  it("persists a complete G32 Tag event and emits the exact durable outbox envelope", async () => {
    const storage = tagStorage();
    const waits: Promise<unknown>[] = [];
    const tagObject = new TagDurableObject({ storage, waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as DurableObjectState, {} as never);
    const tag = "orders:outbox";
    const eventId = g32EventId("tag-outbox-event");
    const response = await tagObject.fetch(new Request(`https://g32.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g32-tag-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "g32-tag-attempt",
        epoch: 0,
        candidates: [{
          eventId,
          suid: g32Suid("tag-outbox-suid"),
          payload: JSON.stringify({ name: "raw-json-not-base64" }),
          eventTags: [tag],
          allocatorLineageId: "g32-tag-lineage",
          eventType: "OrderPlaced",
          provenance: "g32",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    }));
    expect(response.status).toBe(201);
    expect(waits).toHaveLength(0);

    const pending = await tagObject.fetch(new Request(`https://g32.test/outbox/pending?__tag=${encodeURIComponent(tag)}&__serviceId=g32-tag-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowMs: 100 }),
    }));
    const body = await pending.json<{ rows: DownstreamOutboxMessage[] }>();
    expect(pending.status).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      eventId,
      suid: g32Suid("tag-outbox-suid"),
      payload: JSON.stringify({ name: "raw-json-not-base64" }),
      eventType: "OrderPlaced",
      provenance: "g32",
      timestamp: G32_FIXTURE_TIMESTAMP,
    });
    expect(isDownstreamOutboxMessage(body.rows[0])).toBe(true);
    expect(downstreamEnvelopeBytes(body.rows[0]!)).toBe(JSON.stringify(body.rows[0]));
  });

  it("rejects all legacy or identity-less Tag and Queue inputs before durable work", async () => {
    const storage = tagStorage();
    const tagObject = new TagDurableObject({ storage, waitUntil: () => {} } as unknown as DurableObjectState, {} as never);
    const tag = "orders:legacy-rejected";
    const rejected = await tagObject.fetch(new Request(`https://g32.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g32-tag-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "legacy-attempt",
        epoch: 0,
        candidates: [{
          eventId: g32EventId("legacy-rejected"),
          suid: g32Suid("legacy-rejected"),
          payload: "{}",
          eventTags: [tag],
          allocatorLineageId: "legacy-lineage",
          eventType: "OrderPlaced",
          provenance: "pre-g27",
          legacyMigrationMarker: "pre-g27-append-v1",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    }));
    expect(rejected.status).toBe(400);
    expect((await tagObject.fetch(new Request(`https://g32.test/state?__tag=${encodeURIComponent(tag)}`))).status).toBe(404);

    const valid = g32Message({ serviceId: "g32-identity", tag, eventId: "queue-rejected", suid: "queue-rejected", eventType: "OrderPlaced" });
    expect(isDownstreamOutboxMessage({ ...valid, provenance: "pre-g27" })).toBe(false);
    expect(() => resolveDeliveryIdentity({ eventType: "OrderPlaced", provenance: "pre-g27" as never }, "queue")).toThrow(/provenance/i);
    expect(() => resolveDeliveryIdentity({ provenance: "g32" }, "fast")).toThrow(MissingCanonicalEventIdentityError);

    let initialized = 0;
    let recorded = 0;
    await expect(processDeliveryCore({ ...valid, eventType: undefined } as never, "queue", {}, {
      store: {
        initialize: async () => { initialized += 1; },
        recordDelivery: async () => { recorded += 1; throw new Error("must not record"); },
      } as never,
    })).rejects.toThrow(MissingCanonicalEventIdentityError);
    expect(initialized).toBe(0);
    expect(recorded).toBe(0);
  });

  it("carries the admitted G32 identity through DeliveryCore without payload sniffing", async () => {
    const message = g32Message({
      serviceId: "g32-core",
      tag: "orders:core",
      eventId: "core-event",
      suid: "core-suid",
      payload: JSON.stringify({ eventType: "ContradictoryPayloadDiscriminator", value: "preserved" }),
      eventType: "OrderPlaced",
    });
    let records = 0;
    let observed: StoredEvent | undefined;
    const result = await processDeliveryCore(message, "queue", {}, {
      store: coreStore(message, () => { records += 1; }),
      onStored: async ({ event }) => { observed = event; },
    });
    expect(result).toMatchObject({ outcome: "stored", queueDisposition: "ack" });
    expect(records).toBe(1);
    expect(observed).toMatchObject({ eventId: message.eventId, suid: message.suid, eventType: "OrderPlaced", provenance: "g32" });
  });

  it("dispatches by the registered EventType, never a payload discriminator", () => {
    const placed = defineEvent("OrderPlaced");
    const cancelled = defineEvent("OrderCancelled");
    const projector = defineProjector({
      id: "g32-type-dispatch",
      events: [placed, cancelled],
      initialState: [] as string[],
      eventTypeHandlers: {
        OrderPlaced: (state) => [...state, "placed"],
        OrderCancelled: (state) => [...state, "cancelled"],
      },
    });
    const runtime = composeRuntime(defineDomain({ events: [placed, cancelled], projectors: [projector] }))
      .projectors.resolve("g32-type-dispatch")!;
    expect(runtime.apply([], {
      eventId: g32EventId("projection-event"),
      suid: g32Suid("projection-suid"),
      eventTags: [],
      eventType: "OrderPlaced",
      provenance: "g32",
      payload: JSON.stringify({ eventType: "OrderCancelled" }),
    })).toEqual(["placed"]);
    expect(() => runtime.apply([], {
      eventId: g32EventId("projection-missing"),
      suid: g32Suid("projection-missing"),
      eventTags: [],
      eventType: undefined as never,
      provenance: "g32",
      payload: "{}",
    })).toThrow(MissingCanonicalEventIdentityError);
  });
});

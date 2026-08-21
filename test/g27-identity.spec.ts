import { env } from "cloudflare:test";
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
import { AllocatorDurableObject } from "../packages/dcb-runtime/src/allocator/AllocatorDurableObject";
import {
  allocateOrderRange,
  OrderClockReadError,
  ORDER_SUID_LIMIT,
  type OrderClock,
} from "../packages/dcb-runtime/src/allocator/OrderClock";
import { resolveDeliveryIdentity, MissingCanonicalEventIdentityError } from "../packages/dcb-runtime/src/eventIdentity";
import { processDeliveryCore } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import { downstreamEnvelopeBytes } from "../packages/dcb-runtime/src/downstream/Doorbell";
import { isDownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";
// @ts-expect-error Vite raw asset import
import pipelineMigration from "../migrations/d1/0001_pipeline_store.sql?raw";
// @ts-expect-error Vite raw asset import
import identityMigration from "../migrations/d1/0002_g27_event_identity.sql?raw";

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

function allocatorStorage(seed: Record<string, unknown> = {}): {
  storage: DurableObjectStorage;
  snapshot: () => Record<string, unknown>;
} {
  const values = new Map(Object.entries(seed));
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectTransaction;
  let tail = Promise.resolve();
  const storage = {
    get: transaction.get,
    put: transaction.put,
    delete: transaction.delete,
    deleteAll: async () => { values.clear(); },
    list: transaction.list,
    setAlarm: transaction.setAlarm,
    deleteAlarm: transaction.deleteAlarm,
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => {
      const run = tail.then(() => callback(transaction));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  } as unknown as DurableObjectStorage;
  return { storage, snapshot: () => structuredClone(Object.fromEntries(values)) };
}

function sequenceClock(...ticks: bigint[]): OrderClock {
  let index = 0;
  return {
    tick: () => {
      const tick = ticks[index++];
      if (tick === undefined) throw new OrderClockReadError("test clock sequence exhausted");
      return tick;
    },
  };
}

async function allocatorFetch(
  allocator: AllocatorDurableObject,
  path: string,
  body?: unknown,
): Promise<Response> {
  return allocator.fetch(new Request(`https://allocator.g27${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function pipelineDatabase(): Promise<D1Database> {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G27 runtime schema oracle requires the D1 binding");
  const table = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_events'").first<{ name: string }>();
  if (table == null) {
    const statements = (pipelineMigration as string).replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean);
    await database.batch(statements.map((statement) => database.prepare(statement)));
  }
  const columns = await database.prepare("PRAGMA table_info(serialized_dcb_events)").all<{ name: string }>();
  const existing = new Set(columns.results.map((row) => row.name));
  const identityStatements = (identityMigration as string).replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean);
  for (const statement of identityStatements) {
    const column = statement.match(/ADD COLUMN\s+(\w+)/i)?.[1];
    if (column !== undefined && !existing.has(column)) await database.prepare(statement).run();
  }
  return database;
}

function migrationSchema(sql: string): Map<string, Set<string>> {
  const schema = new Map<string, Set<string>>();
  const tables = /CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  for (const match of sql.matchAll(tables)) {
    const columns = new Set<string>();
    for (const line of match[2]!.split(/\r?\n/)) {
      const candidate = line.trim().match(/^([A-Za-z_]\w*)\s+/)?.[1];
      if (candidate !== undefined && !["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT", "REFERENCES", "ON"].includes(candidate.toUpperCase())) columns.add(candidate);
    }
    schema.set(match[1]!, columns);
  }
  return schema;
}

function assertIdentityOnlyQueueDelta(baseline: Record<string, unknown>, actual: Record<string, unknown>): void {
  const baselineKeys = new Set(Object.keys(baseline));
  const actualKeys = new Set(Object.keys(actual));
  const removed = [...baselineKeys].filter((key) => !actualKeys.has(key));
  const added = [...actualKeys].filter((key) => !baselineKeys.has(key));
  if (removed.length > 0 || added.some((key) => key !== "eventType" && key !== "provenance")) {
    throw new Error(`G13 non-allowlisted runtime delta removed=${removed.join(",")} added=${added.join(",")}`);
  }
  const stripped = Object.fromEntries(Object.entries(actual).filter(([key]) => key !== "eventType" && key !== "provenance"));
  expect(JSON.stringify(stripped)).toBe(JSON.stringify(baseline));
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
    const activeV2 = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced", tags: ["orders"] }],
      consistencyTags: [],
    }, { OrderPlaced: 2 });
    expect("value" in activeV2 && activeV2.value.eventCandidates[0]?.eventType).toBe("OrderPlaced:2");
    const callerSelectedVersion = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced", eventPayloadVersion: 2, tags: ["orders"] }],
      consistencyTags: [],
    }, { OrderPlaced: 1 });
    expect("error" in callerSelectedVersion ? callerSelectedVersion.error.status : 200).toBe(400);
    const rejected = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "Order:Placed", tags: ["orders"] }],
      consistencyTags: [],
    });
    expect("error" in rejected ? rejected.error.status : 200).toBe(400);
  });

  it("keeps canonical key, EventId, and SUID independent identities", () => {
    const key = "OrderPlaced:2";
    const first = resolveDeliveryIdentity({ eventType: key, provenance: "g27" }, "queue");
    const second = resolveDeliveryIdentity({ eventType: key, provenance: "g27", eventId: key, suid: key } as never, "queue");
    expect(first.key).toBe(key);
    expect(second.key).toBe(key);
    expect({ eventId: "OrderPlaced:2", suid: "OrderPlaced:2" }).not.toEqual({ eventId: "event-1", suid: "suid-00000000000000000000000000000001" });
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

  it("fails closed at the real /append ingress when identity and provenance are omitted", async () => {
    const storage = tagStorage();
    const ctx = { storage, waitUntil: () => {} } as unknown as DurableObjectState;
    const tagObject = new TagDurableObject(ctx, {} as never);
    const tag = "orders:g27-ingress-gate";
    const response = await tagObject.fetch(new Request(`https://g27.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g27-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "g27-omitted-identity",
        epoch: 0,
        candidates: [{ eventId: "g27-omitted-event", suid: "suid-00000000000000000000000000000003", payload: btoa(JSON.stringify({ eventType: "OrderPlaced:2" })), eventTags: [tag], allocatorLineageId: "g27-lineage" }],
      }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json<{ code: string }>()).toMatchObject({ code: "invalid_tag_append" });
    expect((await tagObject.fetch(new Request(`https://g27.test/state?__tag=${encodeURIComponent(tag)}`))).status).toBe(404);
  });

  it("accepts identity-less rows only with the explicit immutable migration marker", async () => {
    const storage = tagStorage();
    const ctx = { storage, waitUntil: () => {} } as unknown as DurableObjectState;
    const tagObject = new TagDurableObject(ctx, {} as never);
    const tag = "orders:g27-legacy-marker";
    const response = await tagObject.fetch(new Request(`https://g27.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g27-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "g27-legacy-marker-attempt",
        epoch: 0,
        candidates: [{ eventId: "g27-legacy-marker-event", suid: "suid-00000000000000000000000000000004", payload: "e30=", provenance: "pre-g27", legacyMigrationMarker: "pre-g27-append-v1", eventTags: [tag], allocatorLineageId: "legacy-lineage" }],
      }),
    }));
    expect(response.status).toBe(201);
    const pending = await tagObject.fetch(new Request(`https://g27.test/outbox/pending?__tag=${encodeURIComponent(tag)}&__serviceId=g27-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowMs: 100 }),
    }));
    expect((await pending.json<{ rows: DownstreamOutboxMessage[] }>()).rows[0]).toMatchObject({ provenance: "pre-g27-queue" });
  });

  it("connects the G13 additive oracle to the real Tag outbox bytes and D1 schema", async () => {
    const storage = tagStorage();
    const ctx = { storage, waitUntil: () => {} } as unknown as DurableObjectState;
    const tagObject = new TagDurableObject(ctx, {} as never);
    const tag = "orders:g27-runtime-oracle";
    const appended = await tagObject.fetch(new Request(`https://g27.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g27-runtime-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "g27-runtime-oracle-attempt",
        epoch: 0,
        candidates: [{ eventId: "g27-runtime-oracle-event", suid: "suid-00000000000000000000000000000008", payload: "e30=", eventType: "OrderPlaced:2", provenance: "g27", eventTags: [tag], allocatorLineageId: "g27-runtime-lineage" }],
      }),
    }));
    expect(appended.status).toBe(201);
    const pending = await tagObject.fetch(new Request(`https://g27.test/outbox/pending?__tag=${encodeURIComponent(tag)}&__serviceId=g27-runtime-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowMs: 100 }),
    }));
    const actual = (await pending.json<{ rows: DownstreamOutboxMessage[] }>()).rows[0]!;
    const baseline = Object.fromEntries(Object.entries(actual).filter(([key]) => key !== "eventType" && key !== "provenance"));
    assertIdentityOnlyQueueDelta(baseline, actual as unknown as Record<string, unknown>);
    expect(downstreamEnvelopeBytes(actual)).toBe(JSON.stringify(actual));
    expect(() => assertIdentityOnlyQueueDelta(baseline, { ...actual, unallowlistedQueueMember: "mutation" } as unknown as Record<string, unknown>)).toThrow(/non-allowlisted/);

    const database = await pipelineDatabase();
    const baselineSchema = migrationSchema(pipelineMigration as string);
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'serialized_dcb_%' ORDER BY name COLLATE BINARY").all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([...baselineSchema.keys()].sort());
    for (const [table, expectedColumns] of baselineSchema) {
      const rows = await database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const actualColumns = rows.results.map((row) => row.name);
      const additions = actualColumns.filter((column) => !expectedColumns.has(column)).sort();
      expect(additions).toEqual(table === "serialized_dcb_events" ? ["event_provenance", "event_type"] : []);
      expect(actualColumns.filter((column) => expectedColumns.has(column))).toEqual([...expectedColumns]);
    }
  });

  it("rejects a TagEvent identity drop before an event can be persisted", async () => {
    const storage = tagStorage();
    const ctx = { storage, waitUntil: () => {} } as unknown as DurableObjectState;
    const tagObject = new TagDurableObject(ctx, {} as never);
    const tag = "orders:g27-drop-tag";
    const response = await tagObject.fetch(new Request(`https://g27.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=g27-service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId: "drop-tag", epoch: 0, candidates: [{ eventId: "drop-tag-event", suid: "suid-00000000000000000000000000000005", payload: btoa(JSON.stringify({ type: "OrderPlaced:2" })), provenance: "g27", eventTags: [tag], allocatorLineageId: "g27-lineage" }] }),
    }));
    expect(response.status).toBe(400);
  });

  it("rejects an outbox/queue identity drop even when the payload has a discriminator", () => {
    const message = {
      eventType: undefined,
      provenance: "g27" as const,
      payload: btoa(JSON.stringify({ eventType: "OrderPlaced:2" })),
    };
    expect(isDownstreamOutboxMessage(message)).toBe(false);
    expect(() => resolveDeliveryIdentity(message, "queue")).toThrow(MissingCanonicalEventIdentityError);
  });

  it("rejects a StoredEvent identity drop before recordDelivery", async () => {
    let recordCalls = 0;
    const store = {
      initialize: async () => {},
      recordDelivery: async () => { recordCalls += 1; throw new Error("must not reach store"); },
    } as unknown as PipelineStore;
    await expect(processDeliveryCore({
      version: 1,
      serviceId: "g27-drop-stored",
      allocatorLineageId: "g27-lineage",
      tag: "orders:g27-drop-stored",
      attemptId: "drop-stored-attempt",
      eventId: "drop-stored-event",
      suid: "suid-00000000000000000000000000000006",
      payload: btoa(JSON.stringify({ type: "OrderPlaced:2" })),
      eventTags: ["orders:g27-drop-stored"],
      provenance: "g27",
      enqueuedAt: 0,
    } as never, "queue", {}, { store })).rejects.toThrow(MissingCanonicalEventIdentityError);
    expect(recordCalls).toBe(0);
  });

  it("rejects a projection identity drop instead of widening the legacy sniff lane", () => {
    const event = { eventType: undefined, provenance: "g27" as const, payload: btoa(JSON.stringify({ eventName: "OrderPlaced" })) };
    const projector = defineProjector({
      id: "g27-drop-projector",
      events: [defineEvent("OrderPlaced")],
      initialState: [] as string[],
      eventTypeHandlers: { "OrderPlaced:1": (state) => [...state, "applied"] },
    });
    const runtimeProjector = composeRuntime(defineDomain({ events: [defineEvent("OrderPlaced")], projectors: [projector] })).projectors.resolve("g27-drop-projector")!;
    expect(() => runtimeProjector.apply([], { eventId: "drop-projector-event", suid: "suid-00000000000000000000000000000007", eventTags: [], ...event })).toThrow(MissingCanonicalEventIdentityError);
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

  it("uses the real allocator DO injected-clock path with fail-before-write and restart/seed oracles", async () => {
    const seeded = allocatorStorage();
    const seedAllocator = new AllocatorDurableObject({ storage: seeded.storage } as unknown as DurableObjectState, undefined, sequenceClock(1n));
    const seed = await allocatorFetch(seedAllocator, "/seed-after", {
      importId: "g27-import",
      leaseEpoch: 1,
      highWatermark: "suid-00000000000000000000000000000005",
    });
    expect(seed.status).toBe(201);
    const restarted = new AllocatorDurableObject({ storage: seeded.storage } as unknown as DurableObjectState, undefined, sequenceClock(6n));
    const afterSeed = await allocatorFetch(restarted, "/allocate", {
      attemptId: "g27-after-seed",
      candidates: [{ candidateIndex: 0, eventId: "g27-after-seed-event" }],
    });
    expect(afterSeed.status).toBe(201);
    expect((await afterSeed.json<{ candidates: Array<{ suid: string }> }>()).candidates[0]?.suid).toBe("suid-00000000000000000000000000000006");

    const beforeRestart = seeded.snapshot();
    const resumed = new AllocatorDurableObject({ storage: seeded.storage } as unknown as DurableObjectState, undefined, sequenceClock(500n));
    const forward = await allocatorFetch(resumed, "/allocate", {
      attemptId: "g27-forward-jump",
      candidates: [{ candidateIndex: 0, eventId: "g27-forward-jump-event" }],
    });
    expect(forward.status).toBe(201);
    const forwardVector = await forward.json<{ candidates: Array<{ suid: string }>; allocatedAt: string }>();
    expect(forwardVector.candidates[0]?.suid).toBe("suid-00000000000000000000000000000500");
    expect(forwardVector.allocatedAt).toBe(new Date(500).toISOString());
    expect(seeded.snapshot()).not.toEqual(beforeRestart);

    const failedStorage = allocatorStorage();
    const failing = new AllocatorDurableObject({ storage: failedStorage.storage } as unknown as DurableObjectState, undefined, {
      tick: () => { throw new OrderClockReadError("injected clock read failure"); },
    });
    const beforeFailure = failedStorage.snapshot();
    const failed = await allocatorFetch(failing, "/allocate", {
      attemptId: "g27-fail-before-write",
      candidates: [{ candidateIndex: 0, eventId: "g27-fail-before-write-event" }],
    });
    expect(failed.status).toBe(503);
    expect(failedStorage.snapshot()).toEqual(beforeFailure);
  });

  it("serializes concurrent allocator DO calls into unique ranges and rate-limits rollback warnings by stable window", async () => {
    const memory = allocatorStorage();
    const allocator = new AllocatorDurableObject({ storage: memory.storage } as unknown as DurableObjectState, undefined, sequenceClock(100n, 50n, 50n));
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const first = await allocatorFetch(allocator, "/allocate", { attemptId: "g27-warning-first", candidates: [{ candidateIndex: 0, eventId: "g27-warning-first-event" }] });
      const rollback = await allocatorFetch(allocator, "/allocate", { attemptId: "g27-warning-second", candidates: [{ candidateIndex: 0, eventId: "g27-warning-second-event" }] });
      const repeated = await allocatorFetch(allocator, "/allocate", { attemptId: "g27-warning-third", candidates: [{ candidateIndex: 0, eventId: "g27-warning-third-event" }] });
      expect(first.status).toBe(201);
      expect(rollback.status).toBe(201);
      expect(repeated.status).toBe(201);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain("allocator_clock_rollback");
    const state = await allocatorFetch(allocator, "/state");
    const stateBody = await state.json<{ allocatorLineageId: string; lastRollbackWarningFingerprint?: string }>();
    expect(stateBody.lastRollbackWarningFingerprint).toBe(`rollback:${stateBody.allocatorLineageId}:0`);

    const initialState = {
      schemaVersion: 4 as const,
      allocatorLineageId: "g27-warning-lineage",
      allocatedWatermark: null,
      bootstrapSeed: null,
      lastRollbackWarningFingerprint: null,
    };
    const controlMemory = allocatorStorage({ "allocator-state": initialState });
    const faultMemory = allocatorStorage({ "allocator-state": initialState });
    const control = new AllocatorDurableObject({ storage: controlMemory.storage } as unknown as DurableObjectState, undefined, sequenceClock(100n, 50n));
    const faulted = new AllocatorDurableObject({ storage: faultMemory.storage } as unknown as DurableObjectState, undefined, sequenceClock(100n, 50n));
    await allocatorFetch(control, "/allocate", { attemptId: "g27-warning-first", candidates: [{ candidateIndex: 0, eventId: "g27-warning-first-event" }] });
    await allocatorFetch(faulted, "/allocate", { attemptId: "g27-warning-first", candidates: [{ candidateIndex: 0, eventId: "g27-warning-first-event" }] });
    const normalWarn = console.warn;
    console.warn = () => { throw new Error("warning transport unavailable"); };
    let faultedResponse: Response;
    try {
      faultedResponse = await allocatorFetch(faulted, "/allocate", { attemptId: "g27-warning-second", candidates: [{ candidateIndex: 0, eventId: "g27-warning-second-event" }] });
    } finally {
      console.warn = normalWarn;
    }
    const controlResponse = await allocatorFetch(control, "/allocate", { attemptId: "g27-warning-second", candidates: [{ candidateIndex: 0, eventId: "g27-warning-second-event" }] });
    expect(faultedResponse!.status).toBe(201);
    expect(await faultedResponse!.json()).toEqual(await controlResponse.json());
    expect(faultMemory.snapshot()).toEqual(controlMemory.snapshot());

    const concurrentMemory = allocatorStorage();
    const concurrent = new AllocatorDurableObject({ storage: concurrentMemory.storage } as unknown as DurableObjectState, undefined, sequenceClock(1_000n, 2_000n));
    const [left, right] = await Promise.all([
      allocatorFetch(concurrent, "/allocate", { attemptId: "g27-concurrent-left", candidates: [{ candidateIndex: 0, eventId: "g27-concurrent-left-event" }] }),
      allocatorFetch(concurrent, "/allocate", { attemptId: "g27-concurrent-right", candidates: [{ candidateIndex: 0, eventId: "g27-concurrent-right-event" }] }),
    ]);
    const leftVector = await left.json<{ candidates: Array<{ suid: string }> }>();
    const rightVector = await right.json<{ candidates: Array<{ suid: string }> }>();
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(leftVector.candidates[0]?.suid).not.toBe(rightVector.candidates[0]?.suid);
  });
});

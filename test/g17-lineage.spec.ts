import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CosmosClientError, CosmosEventStore } from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type {
  CosmosDocumentClient,
  CosmosDocumentRecord,
} from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { ProjectionRuntime } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { ProjectionCheckpoint, ProjectionLag, ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";

const PAYLOAD = JSON.stringify({});

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function message(
  serviceId: string,
  eventId: string,
  suid: string,
  allocatorLineageId: string,
): DownstreamOutboxMessage {
  return g32Message({
    serviceId,
    allocatorLineageId,
    tag: "g17:lineage",
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    payload: PAYLOAD,
    eventTags: ["g17:lineage"],
    eventType: "G17LineageFixtureEvent",
    enqueuedAt: 1_000,
  });
}

function postgresStore(): PostgresEventStore {
  const url = (env as { POSTGRES_URL?: string }).POSTGRES_URL;
  if (url === undefined) throw new Error("POSTGRES_URL binding is required for G17 tests");
  return new PostgresEventStore(url);
}

class MemoryCosmosClient implements CosmosDocumentClient {
  private readonly rows = new Map<string, { document: Record<string, unknown>; etag: string }>();
  private sequence = 0;

  constructor(private readonly afterCreate?: (container: string, document: Record<string, unknown>) => void) {}

  async initialize(): Promise<void> {}

  private key(container: string, partitionKey: string, id: string): string {
    return `${container}\u0000${partitionKey}\u0000${id}`;
  }

  private copy<T extends Record<string, unknown>>(row: { document: Record<string, unknown>; etag: string }): CosmosDocumentRecord<T> {
    return { document: structuredClone(row.document) as T, etag: row.etag };
  }

  async read<T extends Record<string, unknown>>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    const row = this.rows.get(this.key(container, partitionKey, id));
    return row === undefined ? undefined : this.copy<T>(row);
  }

  async create<T extends Record<string, unknown>>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    const expectedPartition = typeof document.pk === "string" ? document.pk : document.serviceId;
    if (expectedPartition !== partitionKey) throw new Error("Cosmos partition mismatch");
    const key = this.key(container, partitionKey, String(document.id));
    if (this.rows.has(key)) throw new CosmosClientError(409, "duplicate document");
    const row = { document: structuredClone(document), etag: `W/"${++this.sequence}"` };
    this.rows.set(key, row);
    this.afterCreate?.(container, structuredClone(document));
    return this.copy<T>(row);
  }

  async replace<T extends Record<string, unknown>>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    const expectedPartition = typeof document.pk === "string" ? document.pk : document.serviceId;
    if (expectedPartition !== partitionKey) throw new Error("Cosmos partition mismatch");
    const key = this.key(container, partitionKey, String(document.id));
    const current = this.rows.get(key);
    if (current === undefined || (etag !== undefined && current.etag !== etag)) return false;
    const row = { document: structuredClone(document), etag: `W/"${++this.sequence}"` };
    this.rows.set(key, row);
    return true;
  }

  async delete(container: string, id: string, partitionKey: string): Promise<boolean> {
    return this.rows.delete(this.key(container, partitionKey, id));
  }

  async query<T extends Record<string, unknown>>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
    const serviceId = parameters.find((parameter) => parameter.name === "@serviceId")?.value;
    const eventId = parameters.find((parameter) => parameter.name === "@eventId")?.value;
    const result: CosmosDocumentRecord<T>[] = [];
    for (const [key, row] of this.rows) {
      if (!key.startsWith(`${container}\u0000`)) continue;
      const rowPartition = typeof row.document.pk === "string" ? row.document.pk : row.document.serviceId;
      if (partitionKey !== undefined && rowPartition !== partitionKey) continue;
      if (serviceId !== undefined && row.document.serviceId !== serviceId) continue;
      if (eventId !== undefined && row.document.eventId !== eventId) continue;
      if (query.includes("IS_DEFINED(c.sortableUniqueId)") && typeof row.document.sortableUniqueId !== "string") continue;
      result.push(this.copy<T>(row));
    }
    return result;
  }
}

function fakeProjectionStore(events: StoredEvent[]): ProjectionStore & { incidents: string[] } {
  const checkpoints = new Map<string, ProjectionCheckpoint>();
  const store: ProjectionStore & { incidents: string[] } = {
    incidents: [],
    readAllEvents: async () => events,
    currentLagBound: async () => 0,
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async (_serviceId, projectionId) => checkpoints.get(projectionId),
    advanceProjectionCheckpoint: async (input) => {
      const key = input.projectionId;
      const prior = checkpoints.get(key);
      if ((prior?.lastSuid ?? null) !== input.expectedLastSuid) return false;
      checkpoints.set(key, {
        serviceId: input.serviceId,
        projectionId: input.projectionId,
        lastSuid: input.lastSuid,
        stateJson: input.stateJson,
        version: input.version,
        updatedAt: input.updatedAt,
      });
      return true;
    },
    projectionLag: async (serviceId, projectionId, tag): Promise<ProjectionLag> => ({
      serviceId,
      projectionId,
      tag,
      checkpointSuid: "",
      headSuid: "",
      behindEvents: 0,
    }),
    appendDeliveryIncident: async (incident) => {
      store.incidents.push(incident.identityKey);
    },
  };
  return store;
}

describe("SDT-G17 allocator lineage and incident contract", () => {
  it("binds a PostgreSQL service to one allocator lineage and converges wrong-lineage retries", async () => {
    const serviceId = unique("g17-lineage-pg");
    const store = postgresStore();
    await store.initialize();
    const first = message(serviceId, unique("first"), "suid-g17-0001", "lineage-a");
    expect((await store.recordDelivery(first, 2_000)).outcome).toBe("stored");
    const before = await store.readAllEvents(serviceId, "");

    const wrong = message(serviceId, unique("wrong"), "suid-g17-0002", "lineage-b");
    expect((await store.recordDelivery(wrong, 2_001)).outcome).toBe("lineage-mismatch");
    expect((await store.recordDelivery(wrong, 2_002)).outcome).toBe("lineage-mismatch");
    const sameWrongLineage = message(serviceId, unique("wrong-again"), "suid-g17-0003", "lineage-b");
    expect((await store.recordDelivery(sameWrongLineage, 2_003)).outcome).toBe("lineage-mismatch");
    const differentWrongLineage = message(serviceId, unique("wrong-other"), "suid-g17-0004", "lineage-c");
    expect((await store.recordDelivery(differentWrongLineage, 2_004)).outcome).toBe("lineage-mismatch");

    expect(await store.readAllEvents(serviceId, "")).toEqual(before);
    const incidents = await store.listDeliveryIncidents(serviceId);
    expect(incidents.filter((incident) => incident.classification === "LINEAGE_MISMATCH")).toHaveLength(2);
    expect(new Set(incidents.map((incident) => incident.identityKey)).size).toBe(2);
  });

  it("rejects a different EventId for an existing SUID while retaining exact duplicate idempotency", async () => {
    const serviceId = unique("g17-collision-pg");
    const store = postgresStore();
    await store.initialize();
    const first = message(serviceId, unique("stored"), "suid-g17-collision", "lineage-a");
    expect((await store.recordDelivery(first, 3_000)).outcome).toBe("stored");
    const before = await store.readAllEvents(serviceId, "");
    const collision = message(serviceId, unique("collision"), first.suid, "lineage-a");
    expect((await store.recordDelivery(collision, 3_001)).outcome).toBe("suid-collision");
    expect((await store.recordDelivery(collision, 3_002)).outcome).toBe("suid-collision");
    expect(await store.readAllEvents(serviceId, "")).toEqual(before);
    expect((await store.recordDelivery(first, 3_003)).outcome).toBe("stored");
    expect((await store.readAllEvents(serviceId, ""))[0]?.eventId).toBe(first.eventId);
    expect((await store.listDeliveryIncidents(serviceId)).filter((incident) => incident.classification === "SUID_COLLISION")).toHaveLength(1);
  });

  it("rejects a non-colliding Cosmos delivery from a different allocator lineage", async () => {
    const store = new CosmosEventStore({ client: new MemoryCosmosClient() });
    await store.initialize();
    const serviceId = unique("g17-cosmos-lineage");
    const first = message(serviceId, unique("stored"), "suid-g17-cosmos-lineage-1", "lineage-a");
    expect((await store.recordDelivery(first, 3_500)).outcome).toBe("stored");
    const wrong = message(serviceId, unique("wrong"), "suid-g17-cosmos-lineage-2", "lineage-b");
    expect((await store.recordDelivery(wrong, 3_501)).outcome).toBe("lineage-mismatch");
    expect((await store.recordDelivery(wrong, 3_502)).outcome).toBe("lineage-mismatch");
    expect(await store.readAllEvents(serviceId, "")).toHaveLength(1);
    expect((await store.listDeliveryIncidents(serviceId)).map((incident) => incident.classification)).toEqual([
      "LINEAGE_MISMATCH",
    ]);
  });

  it("rejects a different EventId at the same Cosmos SUID and keeps exact duplicates idempotent", async () => {
    const client = new MemoryCosmosClient();
    const store = new CosmosEventStore({ client });
    await store.initialize();
    const serviceId = unique("g17-cosmos-collision");
    const first = message(serviceId, unique("cosmos-stored"), "suid-g17-cosmos-collision", "lineage-a");
    expect((await store.recordDelivery(first, 3_600)).outcome).toBe("stored");
    const before = await store.readAllEvents(serviceId, "");
    // Model a retained historical event whose auxiliary reservation was not
    // present yet.  This forces the event-document collision guard itself to
    // carry the oracle rather than letting the newer reservation guard make
    // the test pass vacuously.
    expect(await client.delete(
      "dcb-events",
      `${encodeURIComponent("suid-binding")}~${encodeURIComponent(first.suid)}`,
      `${serviceId}|__dcb_event_ops__`,
    )).toBe(true);

    const collision = message(serviceId, unique("cosmos-collision"), first.suid, "lineage-a");
    const rejected = await store.recordDelivery(collision, 3_601);
    expect(rejected.outcome).toBe("suid-collision");
    expect(rejected.kind).toBe("suid-collision");
    expect(await store.readAllEvents(serviceId, "")).toEqual(before);
    expect((await store.listDeliveryIncidents(serviceId)).filter((incident) => incident.classification === "SUID_COLLISION")).toHaveLength(1);

    const replay = await store.recordDelivery(first, 3_602);
    expect(replay.outcome).toBe("stored");
    const afterReplay = await store.readAllEvents(serviceId, "");
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]).toMatchObject({ eventId: first.eventId, suid: first.suid, payload: first.payload });
    expect((await store.listDeliveryIncidents(serviceId)).filter((incident) => incident.classification === "SUID_COLLISION")).toHaveLength(1);
  });

  it("acks a typed poison delivery only after the PostgreSQL incident is durable", async () => {
    const serviceId = unique("g17-queue");
    const store = postgresStore();
    await store.initialize();
    const first = message(serviceId, unique("stored"), "suid-g17-queue", "lineage-a");
    expect((await store.recordDelivery(first, 3_700)).outcome).toBe("stored");
    const collision = message(serviceId, unique("collision"), first.suid, "lineage-a");
    const batch = createMessageBatch("serialized-dcb-v1-outbox", [{
      id: unique("g17-queue-message"),
      timestamp: new Date(),
      attempts: 1,
      body: collision,
    }]);
    await handleDownstreamQueue(batch, { POSTGRES_URL: (env as { POSTGRES_URL?: string }).POSTGRES_URL }, {
      store,
      clock: { now: () => 3_701 },
    });
    const queueResult = await getQueueResult(batch, createExecutionContext());
    expect(queueResult.retryMessages).toEqual([]);
    expect(queueResult.explicitAcks).toHaveLength(1);
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(1);
  });

  it("lands Cosmos incidents in dcb-events and retries dcb-findings projection after a fault", async () => {
    const fault = { boundary: undefined as string | undefined };
    const afterFault = { boundary: undefined as string | undefined };
    const client = new MemoryCosmosClient((container, document) => {
      if (afterFault.boundary === "incident" && container === "dcb-events" && document.kind === "delivery-incident") {
        afterFault.boundary = undefined;
        throw new Error("injected failure after incident");
      }
      if (afterFault.boundary === "incident-projection" && container === "dcb-findings" && document.kind === "delivery-incident") {
        afterFault.boundary = undefined;
        throw new Error("injected failure after incident projection");
      }
    });
    const store = new CosmosEventStore({
      client,
      beforeWrite: async (boundary) => {
        if (fault.boundary === boundary) {
          fault.boundary = undefined;
          throw new Error(`injected failure at ${boundary}`);
        }
      },
    });
    await store.initialize();
    const serviceId = unique("g17-cosmos");
    const first = message(serviceId, unique("stored"), "suid-g17-cosmos", "lineage-a");
    expect((await store.recordDelivery(first, 4_000)).outcome).toBe("stored");
    const collision = message(serviceId, unique("collision"), first.suid, "lineage-a");

    fault.boundary = "incident";
    await expect(store.recordDelivery(collision, 4_001)).rejects.toThrow("injected failure");
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(0);
    expect((await store.readAllEvents(serviceId, "")).map((event) => event.eventId)).toEqual([first.eventId]);

    expect((await store.recordDelivery(collision, 4_002)).outcome).toBe("suid-collision");
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(1);
    afterFault.boundary = "incident";
    const collisionAfterIncident = message(serviceId, unique("collision-after-incident"), first.suid, "lineage-a");
    await expect(store.recordDelivery(collisionAfterIncident, 4_003)).rejects.toThrow("injected failure after incident");
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(2);
    expect((await store.recordDelivery(collisionAfterIncident, 4_004)).outcome).toBe("suid-collision");
    fault.boundary = "incident-projection";
    await expect(store.projectDeliveryIncidents(serviceId)).rejects.toThrow("injected failure");
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(2);
    expect(await store.projectDeliveryIncidents(serviceId)).toBe(2);
    const collisionAfterProjection = message(serviceId, unique("collision-after-projection"), first.suid, "lineage-a");
    expect((await store.recordDelivery(collisionAfterProjection, 4_005)).outcome).toBe("suid-collision");
    afterFault.boundary = "incident-projection";
    await expect(store.projectDeliveryIncidents(serviceId)).rejects.toThrow("injected failure after incident projection");
    expect(await store.projectDeliveryIncidents(serviceId)).toBe(3);
    expect((await store.listFindings(serviceId)).length).toBe(0);
    const projected = await client.query<Record<string, unknown>>(
      "dcb-findings",
      "SELECT * FROM c WHERE c.serviceId = @serviceId",
      [{ name: "@serviceId", value: serviceId }],
      serviceId,
    );
    expect(projected).toHaveLength(3);
    expect(projected.every((row) => row.document.classification === "SUID_COLLISION")).toBe(true);
    expect(await store.hasDeliveryIncident(serviceId, (await store.listDeliveryIncidents(serviceId))[0]!.identityKey)).toBe(true);
  });

  it("records ORDER_VIOLATION before preserving the catch-up fail-closed throw", async () => {
    const serviceId = unique("g17-order");
    const event = (suid: string, eventId: string): StoredEvent => ({
      serviceId,
      id: g32EventId(eventId),
      eventId: g32EventId(eventId),
      sortableUniqueId: g32Suid(suid),
      suid: g32Suid(suid),
      payload: PAYLOAD,
      tags: ["orders:g17"],
      eventTags: ["orders:g17"],
      eventType: "G17ProjectionFixtureEvent",
      timestamp: G32_FIXTURE_TIMESTAMP,
      causationId: null,
      correlationId: null,
      executedUser: null,
      provenance: "g32",
      firstArrivedAt: 1,
      lastArrivedAt: 1,
      maxDeliveryLagMs: 0,
      arrivals: [],
    });
    const store = fakeProjectionStore([event("suid-2", "event-2"), event("suid-1", "event-1")]);
    const identity = { tag: "orders:g17", tagGroup: "orders", tagContent: "g17", tagProjector: "test-projector" };
    await expect(new ProjectionRuntime(store).catchUp(serviceId, identity, 50_000)).rejects.toThrow("strictly SUID ordered");
    expect(store.incidents).toHaveLength(1);
    expect(store.incidents[0]).toContain("ORDER_VIOLATION");
  });
});

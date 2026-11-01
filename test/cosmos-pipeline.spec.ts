import { describe, expect, it } from "vitest";

import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { G11_SERVICE_ID_HEADER, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { handleSerializedRead } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import { DEPLOYED_PROJECTOR_REGISTRY, tagStateIdentityFrom } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { ProjectionRuntime } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import {
  createCosmosStoreProvider,
  CosmosClientError,
  DEFAULT_COSMOS_CONTAINERS,
} from "../packages/dcb-runtime/src/cosmos";
import { CosmosEventStore } from "../packages/dcb-runtime/src/store/CosmosEventStore";
import {
  COSMOS_BINDINGS,
  COSMOS_CONTAINER_LAYOUT,
  COSMOS_CONTAINER_NAMES,
  COSMOS_DOCUMENT_ID_RULES,
  COSMOS_LAYOUT_STABILITY,
} from "../packages/dcb-runtime/src/generated/cosmos-layout";
import {
  COSMOS_AUXILIARY_PARTITION_KEY_PATH,
  COSMOS_EVENT_PARTITION_KEY_PATH,
  COSMOS_PARTITION_KEY_PATH,
  cosmosContainerDefinitions,
} from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { CosmosDocumentClient, CosmosDocumentRecord } from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message, g32SuidAt } from "./helpers/g32-fixtures";

type JsonObject = Record<string, unknown>;

class PipelineMemoryClient implements CosmosDocumentClient {
  private readonly rows = new Map<string, { document: JsonObject; etag: string }>();
  private etag = 0;
  readonly observations: Array<{
    container: string;
    id?: string;
    partitionKey?: string;
    serviceId?: string;
  }> = [];
  readonly queries: string[] = [];

  async initialize(): Promise<void> {}

  private key(container: string, partitionKey: string, id: string): string {
    return `${container}\u0000${partitionKey}\u0000${id}`;
  }

  private copy<T extends JsonObject>(record: { document: JsonObject; etag: string }): CosmosDocumentRecord<T> {
    return { document: JSON.parse(JSON.stringify(record.document)) as T, etag: record.etag };
  }

  async read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    this.observations.push({ container, id, partitionKey, serviceId: partitionKey });
    const row = this.rows.get(this.key(container, partitionKey, id));
    return row === undefined ? undefined : this.copy<T>(row);
  }

  async create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    if (document.serviceId !== partitionKey && !(container === DEFAULT_COSMOS_CONTAINERS.events && document.pk === partitionKey)) {
      throw new Error("partition key mismatch");
    }
    this.observations.push({ container, id: String(document.id), partitionKey, serviceId: String(document.serviceId) });
    const key = this.key(container, partitionKey, String(document.id));
    if (this.rows.has(key)) throw new CosmosClientError(409, "duplicate document");
    const row = { document: JSON.parse(JSON.stringify(document)) as JsonObject, etag: `W/"${++this.etag}"` };
    this.rows.set(key, row);
    return this.copy<T>(row);
  }

  async replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    if (document.serviceId !== partitionKey && !(container === DEFAULT_COSMOS_CONTAINERS.events && document.pk === partitionKey)) {
      throw new Error("partition key mismatch");
    }
    this.observations.push({ container, id: String(document.id), partitionKey, serviceId: String(document.serviceId) });
    const key = this.key(container, partitionKey, String(document.id));
    const current = this.rows.get(key);
    if (current === undefined || (etag !== undefined && current.etag !== etag)) return false;
    this.rows.set(key, { document: JSON.parse(JSON.stringify(document)) as JsonObject, etag: `W/"${++this.etag}"` });
    return true;
  }

  async query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
    this.queries.push(query);
    const serviceId = parameters.find((parameter) => parameter.name === "@serviceId")?.value;
    const eventId = parameters.find((parameter) => parameter.name === "@eventId")?.value;
    this.observations.push({
      container,
      partitionKey,
      serviceId: typeof serviceId === "string" ? serviceId : undefined,
    });
    const rows: CosmosDocumentRecord<T>[] = [];
    for (const [key, row] of this.rows) {
      if (!key.startsWith(`${container}\u0000`)) continue;
      if (query.includes("IS_DEFINED(c.sortableUniqueId)") && typeof row.document.sortableUniqueId !== "string") continue;
      if (!checkpointQueryMatches(query, parameters, row.document)) continue;
      if (partitionKey !== undefined && row.document.serviceId !== partitionKey) continue;
      if (serviceId !== undefined && row.document.serviceId !== serviceId) continue;
      if (eventId !== undefined && row.document.eventId !== eventId) continue;
      rows.push(this.copy<T>(row));
    }
    return finishCheckpointQuery(query, parameters, rows);
  }
}

function parameterValue(parameters: readonly { name: string; value: unknown }[], name: string): unknown {
  return parameters.find((parameter) => parameter.name === name)?.value;
}

function checkpointQueryMatches(
  query: string,
  parameters: readonly { name: string; value: unknown }[],
  document: { projectionId?: unknown },
): boolean {
  if (!query.includes("STARTSWITH(c.projectionId")) return true;
  const prefix = parameterValue(parameters, "@prefix");
  const suffix = parameterValue(parameters, "@suffix");
  return typeof document.projectionId === "string"
    && typeof prefix === "string"
    && typeof suffix === "string"
    && document.projectionId.startsWith(prefix)
    && document.projectionId.endsWith(suffix);
}

function finishCheckpointQuery<T extends { document: { projectionId?: unknown } }>(
  query: string,
  parameters: readonly { name: string; value: unknown }[],
  rows: T[],
): T[] {
  if (!query.includes("STARTSWITH(c.projectionId")) return rows;
  const ordered = query.includes("ORDER BY c.projectionId")
    ? [...rows].sort((left, right) => {
      const first = String(left.document.projectionId);
      const second = String(right.document.projectionId);
      if (first < second) return -1;
      if (first > second) return 1;
      return 0;
    })
    : rows;
  const limit = parameterValue(parameters, "@limit");
  if (query.includes("SELECT TOP") && typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0) {
    return ordered.slice(0, limit);
  }
  return ordered;
}

const SERVICE_ID = "local-test-runtime";

function missingTagNamespace(): DurableObjectNamespace {
  const tagObject = { fetch: async () => new Response(null, { status: 404 }) };
  return {
    idFromName: () => ({}) as DurableObjectId,
    get: () => tagObject,
  } as unknown as DurableObjectNamespace;
}

function testMessage(): DownstreamOutboxMessage {
  return g32Message({
    serviceId: SERVICE_ID,
    allocatorLineageId: "test-cosmos-lineage",
    tag: "test:cosmos-provider",
    attemptId: "cosmos-provider-attempt",
    eventId: "cosmos-provider-event",
    suid: g32SuidAt(1_000, "cosmos-provider-suid"),
    payload: JSON.stringify({ forecastId: "cosmos" }),
    eventTags: ["test:cosmos-provider"],
    eventType: "CosmosProviderEvent",
    enqueuedAt: 0,
  });
}

describe("SDT-G12 Cosmos provider pipeline composition", () => {
  it("runs downstream delivery, projection catch-up, and both query endpoints through the explicit provider", async () => {
    const provider = createCosmosStoreProvider({ client: new PipelineMemoryClient() });
    const env = { SDT_SERVICE_ID: SERVICE_ID } as Parameters<typeof processDownstreamDelivery>[1];
    const entry = testMessage();
    await processDownstreamDelivery(entry, env, {
      storeProvider: provider,
      clock: { now: () => 1_000 },
    });

    const store = provider.create(env);
    await store.initialize();
    const identity = tagStateIdentityFrom("test:cosmos-provider:test-projector").value!;
    const caughtUp = await new ProjectionRuntime(store, DEPLOYED_PROJECTOR_REGISTRY).catchUp(SERVICE_ID, identity, 22_000);
    expect(caughtUp.appliedEvents).toBe(1);

    const query = (path: string, body: unknown) => handleSerializedQuery(
      new Request(`https://cosmos-provider.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      { storeProvider: provider },
    );
    const scalar = await query("/api/sekiban/serialized/query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{}",
    });
    expect(scalar.status).toBe(200);
    expect(JSON.parse((await scalar.json<{ resultJson: string }>()).resultJson)).toEqual({ count: 1 });
    const list = await query("/api/sekiban/serialized/list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 10 }),
    });
    expect(list.status).toBe(200);
    expect(JSON.parse((await list.json<{ itemsJson: string }>()).itemsJson)).toHaveLength(1);
  });

  it("pins the separate five-container, service-partitioned layout", async () => {
    expect(COSMOS_LAYOUT_STABILITY).toBe("experimental");
    expect(COSMOS_BINDINGS).toEqual({ endpoint: "COSMOS_ENDPOINT", database: "COSMOS_DATABASE", key: "COSMOS_KEY" });
    expect(DEFAULT_COSMOS_CONTAINERS).toEqual(COSMOS_CONTAINER_NAMES);
    const definitions = cosmosContainerDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual(Object.values(COSMOS_CONTAINER_NAMES));
    expect(definitions).toHaveLength(5);
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(5);
    expect(COSMOS_PARTITION_KEY_PATH).toBe(COSMOS_AUXILIARY_PARTITION_KEY_PATH);
    expect(definitions[0]?.partitionKeyPath).toBe(COSMOS_EVENT_PARTITION_KEY_PATH);
    expect(definitions.slice(1).every((definition) => definition.partitionKeyPath === COSMOS_AUXILIARY_PARTITION_KEY_PATH)).toBe(true);
    expect(definitions[0]?.partitionKeyValue(SERVICE_ID, "event-id")).toBe(`${SERVICE_ID}|event-id`);
    expect(() => definitions[0]?.partitionKeyValue(SERVICE_ID)).toThrow(/event id/i);
    expect(definitions.slice(1).map((definition) => definition.partitionKeyValue(SERVICE_ID))).toEqual(
      definitions.slice(1).map(() => SERVICE_ID),
    );
    expect(COSMOS_DOCUMENT_ID_RULES).toEqual({
      events: {
        logicalEvent: "canonical event id",
        eventSidecar: "safeId(\"event-ops\", eventId)",
        serviceGuards: {
          allocatorLineageBinding: "safeId(\"allocator-lineage-binding\")",
          suidBinding: "safeId(\"suid-binding\", suid)",
          deliveryIncident: "safeId(\"incident\", identityKey)",
        },
      },
      lagEstimates: { lagEstimate: "serviceId" },
      pendingArrivals: { pendingArrival: "safeId(eventId)" },
      findings: {
        finding: "safeId(eventId, path, classification)",
        incidentProjection: "safeId(\"incident\", identityKey)",
      },
      checkpoints: { checkpoint: "safeId(projectionId)" },
    });

    const client = new PipelineMemoryClient();
    const store = createCosmosStoreProvider({ client }).create({});
    await store.initialize();
    await store.recordDelivery(testMessage(), 1_000);
    const observedEventPartitions = client.observations
      .filter((observation) => observation.container === DEFAULT_COSMOS_CONTAINERS.events)
      .map((observation) => observation.partitionKey)
      .filter((value): value is string => value !== undefined);
    expect(observedEventPartitions).toContain(`${SERVICE_ID}|${testMessage().eventId}`);
    expect(observedEventPartitions).toContain(`${SERVICE_ID}|__dcb_event_ops__`);
    const sidecarId = ["event-ops", testMessage().eventId].map(encodeURIComponent).join("~");
    expect(client.observations.some((observation) => observation.id === testMessage().eventId && observation.partitionKey === `${SERVICE_ID}|${testMessage().eventId}`)).toBe(true);
    expect(client.observations.some((observation) => observation.id === sidecarId && observation.partitionKey === `${SERVICE_ID}|${testMessage().eventId}`)).toBe(true);
    expect(client.observations.some((observation) => observation.id === "allocator-lineage-binding" && observation.partitionKey === `${SERVICE_ID}|__dcb_event_ops__`)).toBe(true);
    expect(COSMOS_CONTAINER_LAYOUT.events.partitionKeyPath).toBe(COSMOS_EVENT_PARTITION_KEY_PATH);
    expect(COSMOS_CONTAINER_LAYOUT.findings.partitionKeyPath).toBe(COSMOS_AUXILIARY_PARTITION_KEY_PATH);

    // The historical .NET layout is a separate namespace, not an alias for a
    // TypeScript container. This negative contract catches a five-name rename
    // even when all document operations remain otherwise green.
    const historicalDotNetContainers = new Set(["events", "tags", "states"]);
    expect(definitions.every((definition) => !historicalDotNetContainers.has(definition.name))).toBe(true);
  });

  it("keeps Cosmos query/read service and partition keys fail-closed on production headers", async () => {
    const client = new PipelineMemoryClient();
    const provider = createCosmosStoreProvider({ client });
    const hostileHeaders = {
      "content-type": "application/json",
      [G11_SERVICE_ID_HEADER]: "g11-attacker-namespace",
      [TEST_SERVICE_ID_HEADER]: "g9-attacker-namespace",
    };
    const queryResponse = await handleSerializedQuery(
      new Request("https://api.example.com/api/sekiban/serialized/query", {
        method: "POST",
        headers: hostileHeaders,
        body: JSON.stringify({ queryType: "GetTestCountQuery", queryParamsJson: "{}" }),
      }),
      { SDT_SERVICE_ID: SERVICE_ID },
      { storeProvider: provider },
    );
    expect(queryResponse.status).toBe(200);

    const readResponse = await handleSerializedRead(
      new Request("https://api.example.com/api/sekiban/serialized/tag-latest-sortable", {
        method: "POST",
        headers: hostileHeaders,
        body: JSON.stringify({ tag: "test:cosmos-provider" }),
      }),
      { TAG: missingTagNamespace(), SDT_SERVICE_ID: SERVICE_ID },
      DEPLOYED_PROJECTOR_REGISTRY,
      provider,
    );
    expect(readResponse.status).toBe(200);
    expect(client.observations.length).toBeGreaterThan(0);
    const scoped = client.observations.filter((observation) => observation.serviceId !== undefined);
    expect(new Set(scoped.map((observation) => observation.serviceId))).toEqual(new Set([SERVICE_ID]));
    expect(client.observations.filter((observation) => observation.container !== DEFAULT_COSMOS_CONTAINERS.events).every((observation) => observation.partitionKey === SERVICE_ID)).toBe(true);
    // CosmosEvent is partitioned by serviceId|eventId, so a service-scoped
    // event listing uses a service predicate rather than a forged single PK.
    expect(client.observations.some((observation) => observation.container === DEFAULT_COSMOS_CONTAINERS.events && observation.partitionKey === undefined)).toBe(true);

    // The reserved .test + explicit verification flag remains the only
    // intentional deployment-isolation override.
    const overrideClient = new PipelineMemoryClient();
    const overrideResponse = await handleSerializedQuery(
      new Request("https://cosmos.test/api/sekiban/serialized/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [G11_SERVICE_ID_HEADER]: "g11-test-namespace",
        },
        body: JSON.stringify({ queryType: "GetTestCountQuery", queryParamsJson: "{}" }),
      }),
      { G11_VERIFICATION_ENABLED: "true" },
      { storeProvider: createCosmosStoreProvider({ client: overrideClient }) },
    );
    expect(overrideResponse.status).toBe(200);
    expect(new Set(overrideClient.observations.map((observation) => observation.serviceId).filter((value): value is string => value !== undefined))).toEqual(
      new Set(["g11-test-namespace"]),
    );
    expect(overrideClient.observations.every((observation) => observation.partitionKey === undefined || observation.partitionKey === "g11-test-namespace")).toBe(true);
  });
});

describe("dormant cosmos checkpoint scan", () => {
  it("keeps the document seam partitioned, predicated, ordered, and bounded", async () => {
    const client = new PipelineMemoryClient();
    const store = new CosmosEventStore({ client });
    await store.initialize();
    const serviceId = "cosmos-seam";
    const inserted = [
      ["n", "board", serviceId],
      ["é", "board", serviceId],
      ["a", "board", serviceId],
      ["000", "WRONG", serviceId],
      ["a", "board", "other-service"],
    ] as const;
    for (const [content, projector, owner] of inserted) {
      expect(await store.advanceProjectionCheckpoint({
        serviceId: owner,
        projectionId: `tag-state:room:${content}:${projector}`,
        expectedLastSuid: null,
        lastSuid: `suid-${content}`,
        stateJson: JSON.stringify({ label: content }),
        version: 1,
        updatedAt: 1,
      })).toBe(true);
    }
    const scanned = await store.scanProjectionCheckpointCandidates({
      serviceId,
      projectionIdPrefix: "tag-state:room:",
      projectionIdSuffix: ":board",
      limit: 2,
    });
    expect(scanned.map((row) => row.projectionId)).toEqual([
      "tag-state:room:a:board",
      "tag-state:room:n:board",
    ]);
    expect(scanned.every((row) => typeof row.stateJson === "string")).toBe(true);
  });

  it("runs an executable query through the worker without the legacy read branch", async () => {
    const client = new PipelineMemoryClient();
    const store = new CosmosEventStore({ client });
    await store.initialize();
    const serviceId = "cosmos-executable";
    for (const [content, label] of [["n", "north"], ["a", "alpha"], ["é", "latin"]] as const) {
      expect(await store.advanceProjectionCheckpoint({
        serviceId,
        projectionId: `tag-state:room:${content}:board`,
        expectedLastSuid: null,
        lastSuid: `suid-${content}`,
        stateJson: JSON.stringify({ label }),
        version: 1,
        updatedAt: 1,
      })).toBe(true);
    }
    const seen: unknown[] = [];
    const codec = { encode: (value: unknown) => value, decode: (value: unknown) => value };
    const { QueryRegistry } = await import("../packages/dcb-runtime/src/query/QueryRegistry");
    const { ProjectorRegistry } = await import("../packages/dcb-runtime/src/projection/ProjectorRegistry");
    const registry = new QueryRegistry([{
      queryType: "worker-list",
      endpoint: "list-query",
      tagGroup: "room",
      tagProjector: "board",
      enabled: true,
      version: 1,
      execution: {
        kind: "list",
        rowCodec: {
          decode(value: unknown) {
            if (typeof value !== "object" || value === null || typeof (value as { label?: unknown }).label !== "string") throw new Error("row-secret");
            return { label: (value as { label: string }).label };
          },
          encode: (value: unknown) => value,
        },
        paramsCodec: {
          decode(value: unknown) {
            seen.push(value);
            if (typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "PageNumber")) throw new Error("control");
            if (typeof value !== "object" || value === null || typeof (value as { roomId?: unknown }).roomId !== "string") throw new Error("params-secret");
            return { roomId: (value as { roomId: string }).roomId };
          },
          encode: (value: unknown) => value,
        },
        itemCodec: codec,
        handleFilter: (projection: { rows: { key: string; value: { label: string } }[] }) => projection.rows.map((row) => ({ key: row.key, label: row.value.label })),
        handleSort: (items: readonly { key: string; label: string }[]) => items,
      },
    }]);
    const projectors = new ProjectorRegistry([{
      id: "board",
      tagPayloadName: "Board",
      projectorVersion: "1",
      initialState: () => ({}),
      apply: (state: unknown) => state,
      serializeState: () => "{}",
      deserializeState: () => ({}),
      payload: () => "{}",
      version: () => 1,
    }]);
    client.queries.length = 0;
    const response = await handleSerializedQuery(new Request("https://cosmos.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
      body: JSON.stringify({
        queryType: "worker-list",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 2, roomId: "room-1" }),
      }),
    }), {}, { registry, projectors, store });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      itemsJson: JSON.stringify([{ key: "a", label: "alpha" }, { key: "n", label: "north" }]),
      totalCount: 3,
      currentPage: 1,
      pageSize: 2,
    });
    expect(seen).toEqual([{ roomId: "room-1" }]);
    expect(client.queries.some((query) => query.includes("STARTSWITH(c.projectionId"))).toBe(true);
    expect(client.queries.some((query) => query.includes("limit: null") || query.includes("LIMIT null"))).toBe(false);
    const corrupt = new CosmosEventStore({ client: new PipelineMemoryClient() });
    await corrupt.initialize();
    expect(await corrupt.advanceProjectionCheckpoint({
      serviceId,
      projectionId: "tag-state:room:bad:board",
      expectedLastSuid: null,
      lastSuid: "suid-bad",
      stateJson: "{",
      version: 1,
      updatedAt: 2,
    })).toBe(true);
    const corruptResponse = await handleSerializedQuery(new Request("https://cosmos.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
      body: JSON.stringify({ queryType: "worker-count", queryParamsJson: JSON.stringify({ roomId: "room-1" }) }),
    }), {}, {
      registry: new QueryRegistry([{
        queryType: "worker-count",
        endpoint: "query",
        tagGroup: "room",
        tagProjector: "board",
        enabled: true,
        version: 1,
        execution: {
          kind: "scalar",
          rowCodec: {
            decode(value: unknown) {
              if (typeof value !== "object" || value === null || typeof (value as { label?: unknown }).label !== "string") throw new Error("row-secret");
              return value;
            },
            encode: (value: unknown) => value,
          },
          paramsCodec: { decode: () => ({ roomId: "room-1" }), encode: (value: unknown) => value },
          resultCodec: codec,
          handleQuery: () => ({ count: 1 }),
        },
      }]),
      projectors,
      store: corrupt,
    });
    expect(corruptResponse.status).toBe(500);
    await expect(corruptResponse.json()).resolves.toEqual({
      error: "The query projection contains an invalid row.",
      code: "query_row_invalid",
    });
  });
});

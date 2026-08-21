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
import {
  COSMOS_PARTITION_KEY_PATH,
  cosmosContainerDefinitions,
} from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { CosmosDocumentClient, CosmosDocumentRecord } from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

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
    if (document.serviceId !== partitionKey) throw new Error("partition key mismatch");
    this.observations.push({ container, partitionKey, serviceId: String(document.serviceId) });
    const key = this.key(container, partitionKey, String(document.id));
    if (this.rows.has(key)) throw new CosmosClientError(409, "duplicate document");
    const row = { document: JSON.parse(JSON.stringify(document)) as JsonObject, etag: `W/"${++this.etag}"` };
    this.rows.set(key, row);
    return this.copy<T>(row);
  }

  async replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    if (document.serviceId !== partitionKey) throw new Error("partition key mismatch");
    this.observations.push({ container, partitionKey, serviceId: String(document.serviceId) });
    const key = this.key(container, partitionKey, String(document.id));
    const current = this.rows.get(key);
    if (current === undefined || (etag !== undefined && current.etag !== etag)) return false;
    this.rows.set(key, { document: JSON.parse(JSON.stringify(document)) as JsonObject, etag: `W/"${++this.etag}"` });
    return true;
  }

  async query<T extends JsonObject>(
    container: string,
    _query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
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
      if (partitionKey !== undefined && row.document.serviceId !== partitionKey) continue;
      if (serviceId !== undefined && row.document.serviceId !== serviceId) continue;
      if (eventId !== undefined && row.document.eventId !== eventId) continue;
      rows.push(this.copy<T>(row));
    }
    return rows;
  }
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
  return {
    version: 1,
    serviceId: SERVICE_ID,
    allocatorLineageId: "test-cosmos-lineage",
    tag: "test:cosmos-provider",
    attemptId: "cosmos-provider-attempt",
    eventId: "cosmos-provider-event",
    suid: "suid-00000000000000000000000000000001",
    payload: "eyJmb3JlY2FzdElkIjoiY29zbW9zIn0=",
    eventTags: ["test:cosmos-provider"],
    provenance: "pre-g27-queue",
    enqueuedAt: 0,
  };
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

  it("pins the separate five-container, service-partitioned layout", () => {
    expect(DEFAULT_COSMOS_CONTAINERS).toEqual({
      events: "dcb-events",
      lagEstimates: "dcb-lag-estimates",
      pendingArrivals: "dcb-pending-arrivals",
      findings: "dcb-findings",
      checkpoints: "dcb-projection-checkpoints",
    });

    const definitions = cosmosContainerDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual([
      "dcb-events",
      "dcb-lag-estimates",
      "dcb-pending-arrivals",
      "dcb-findings",
      "dcb-projection-checkpoints",
    ]);
    expect(definitions).toHaveLength(5);
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(5);
    expect(definitions.every((definition) => definition.partitionKeyPath === COSMOS_PARTITION_KEY_PATH)).toBe(true);
    expect(definitions.every((definition) => definition.partitionKeyPath === "/serviceId")).toBe(true);
    expect(definitions.map((definition) => definition.partitionKeyValue(SERVICE_ID))).toEqual(
      definitions.map(() => SERVICE_ID),
    );

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
    expect(new Set(client.observations.map((observation) => observation.partitionKey))).toEqual(new Set([SERVICE_ID]));
    expect(new Set(client.observations.map((observation) => observation.serviceId))).toEqual(new Set([SERVICE_ID]));

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
    expect(new Set(overrideClient.observations.map((observation) => observation.partitionKey))).toEqual(
      new Set(["g11-test-namespace"]),
    );
  });
});

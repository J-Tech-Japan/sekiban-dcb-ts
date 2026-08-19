import { describe, expect, it } from "vitest";

import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { DEPLOYED_PROJECTOR_REGISTRY, tagStateIdentityFrom } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { ProjectionRuntime } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { createCosmosStoreProvider, CosmosClientError } from "../packages/dcb-runtime/src/cosmos";
import type { CosmosDocumentClient, CosmosDocumentRecord } from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

type JsonObject = Record<string, unknown>;

class PipelineMemoryClient implements CosmosDocumentClient {
  private readonly rows = new Map<string, { document: JsonObject; etag: string }>();
  private etag = 0;

  async initialize(): Promise<void> {}

  private key(container: string, partitionKey: string, id: string): string {
    return `${container}\u0000${partitionKey}\u0000${id}`;
  }

  private copy<T extends JsonObject>(record: { document: JsonObject; etag: string }): CosmosDocumentRecord<T> {
    return { document: JSON.parse(JSON.stringify(record.document)) as T, etag: record.etag };
  }

  async read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    const row = this.rows.get(this.key(container, partitionKey, id));
    return row === undefined ? undefined : this.copy<T>(row);
  }

  async create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    if (document.serviceId !== partitionKey) throw new Error("partition key mismatch");
    const key = this.key(container, partitionKey, String(document.id));
    if (this.rows.has(key)) throw new CosmosClientError(409, "duplicate document");
    const row = { document: JSON.parse(JSON.stringify(document)) as JsonObject, etag: `W/"${++this.etag}"` };
    this.rows.set(key, row);
    return this.copy<T>(row);
  }

  async replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    if (document.serviceId !== partitionKey) throw new Error("partition key mismatch");
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

const SERVICE_ID = "serialized-dcb-v1";

function testMessage(): DownstreamOutboxMessage {
  return {
    version: 1,
    serviceId: SERVICE_ID,
    tag: "test:cosmos-provider",
    attemptId: "cosmos-provider-attempt",
    eventId: "cosmos-provider-event",
    suid: "suid-00000000000000000000000000000001",
    payload: "eyJmb3JlY2FzdElkIjoiY29zbW9zIn0=",
    eventTags: ["test:cosmos-provider"],
    enqueuedAt: 0,
  };
}

describe("SDT-G12 Cosmos provider pipeline composition", () => {
  it("runs downstream delivery, projection catch-up, and both query endpoints through the explicit provider", async () => {
    const provider = createCosmosStoreProvider({ client: new PipelineMemoryClient() });
    const env = {} as Parameters<typeof processDownstreamDelivery>[1];
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
});

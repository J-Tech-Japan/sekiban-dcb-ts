import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createCosmosStoreProvider, DEFAULT_COSMOS_CONTAINERS } from "../packages/dcb-runtime/src/cosmos";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { CosmosDocumentClient, CosmosDocumentRecord } from "../packages/dcb-runtime/src/store/CosmosEventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { ProjectionRuntime } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { tagStateIdentityFrom } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
// @ts-expect-error Vite raw asset import
import migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import
import manifestSource from "../contracts/event-store-ddl.json?raw";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

type JsonObject = Record<string, unknown>;

type LogicalField = {
  readonly id: string;
  readonly postgres: string;
  readonly d1: string;
  readonly cosmos: string;
  readonly nullable: boolean;
};

type Manifest = {
  readonly logicalRecord: { readonly table: string; readonly fields: readonly LogicalField[] };
  readonly cosmos: {
    readonly pk: string;
    readonly applicationFields: readonly string[];
    readonly providerManagedReadonlyFields: readonly string[];
  };
};

type CsharpArtifact = {
  readonly postgres: JsonObject;
  readonly cosmos: JsonObject;
};

declare const __G32_PARITY_ARTIFACT_B64__: string;

const manifest = JSON.parse(manifestSource as string) as Manifest;
const encodedArtifact = __G32_PARITY_ARTIFACT_B64__;
const artifact = encodedArtifact.length === 0
  ? undefined
  : JSON.parse(Buffer.from(encodedArtifact, "base64").toString("utf8")) as CsharpArtifact;

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("G32 C# parity fixture requires the D1 binding");
  return binding;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`manifest supplied unsafe SQL identifier ${value}`);
  return `"${value}"`;
}

async function ensureG32Migration(database: D1Database): Promise<void> {
  const existing = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'").first<{ name: string }>();
  if (existing === null) {
    const statements = (migration as string)
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await database.batch(statements.map((statement) => database.prepare(statement)));
  }
  await applyG44D1Migration(database);
}

function logicalFromProvider(row: JsonObject, provider: "postgres" | "cosmos"): JsonObject {
  const logical: JsonObject = {};
  for (const field of manifest.logicalRecord.fields) {
    const key = field[provider];
    expect(Object.hasOwn(row, key), `${provider} row omitted manifest field ${key}`).toBe(true);
    const value = row[key];
    expect(value === null && !field.nullable, `${provider} row made required ${field.id} null`).toBe(false);
    logical[field.id] = value;
  }
  return logical;
}

function eventTags(logical: JsonObject): string[] {
  const tags = logical.tags;
  const decoded = typeof tags === "string" ? JSON.parse(tags) : tags;
  expect(Array.isArray(decoded) && decoded.every((entry) => typeof entry === "string")).toBe(true);
  return [...decoded as string[]];
}

function sourceEnvelope(logical: JsonObject): DownstreamOutboxMessage {
  const tags = eventTags(logical);
  expect(tags.length).toBeGreaterThan(0);
  return {
    version: 1,
    serviceId: String(logical.serviceId),
    allocatorLineageId: "g32-csharp-parity-import-lineage",
    tag: tags[0]!,
    attemptId: "g32-csharp-parity-import-attempt",
    eventId: String(logical.id),
    suid: String(logical.sortableUniqueId),
    payload: String(logical.payload),
    eventTags: tags,
    eventType: String(logical.eventType),
    provenance: "g32",
    timestamp: String(logical.timestamp),
    causationId: logical.causationId === null ? null : String(logical.causationId),
    correlationId: logical.correlationId === null ? null : String(logical.correlationId),
    executedUser: logical.executedUser === null ? null : String(logical.executedUser),
    enqueuedAt: 1_787_414_836_123,
    completeness: {
      canonicalBytesBase64: "ZzMyLWNzaGFycC1pbXBvcnQ=",
      eventDigest: "c".repeat(64),
      declaredTagSet: [...tags].sort(),
      localCommittedMembership: [{ serviceId: String(logical.serviceId), eventId: String(logical.id), tag: tags[0]! }],
      obligationSequence: 1,
    },
  };
}

function assertProviderRow(logical: JsonObject, actual: JsonObject, provider: "d1" | "cosmos"): void {
  for (const field of manifest.logicalRecord.fields) {
    expect(actual[field[provider]], `${provider} provider row drifted at ${field.id}`).toEqual(logical[field.id]);
  }
}

function expectedPk(logical: JsonObject): string {
  return manifest.cosmos.pk.replace(/\{([^}]+)\}/g, (_whole, field: string) => String(logical[field]));
}

class CapturingCosmosClient implements CosmosDocumentClient {
  private readonly rows = new Map<string, { document: JsonObject; etag: string }>();
  private etag = 0;

  async initialize(): Promise<void> {}

  private key(container: string, partitionKey: string, id: string): string {
    return `${container}\u0000${partitionKey}\u0000${id}`;
  }

  private copy<T extends JsonObject>(row: { document: JsonObject; etag: string }): CosmosDocumentRecord<T> {
    return { document: structuredClone(row.document) as T, etag: row.etag };
  }

  async read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    const row = this.rows.get(this.key(container, partitionKey, id));
    return row === undefined ? undefined : this.copy<T>(row);
  }

  async create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    const key = this.key(container, partitionKey, String(document.id));
    if (this.rows.has(key)) throw Object.assign(new Error("duplicate document"), { status: 409 });
    const row = { document: structuredClone(document) as JsonObject, etag: `W/"${++this.etag}"` };
    this.rows.set(key, row);
    return this.copy<T>(row);
  }

  async replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    const key = this.key(container, partitionKey, String(document.id));
    const current = this.rows.get(key);
    if (current === undefined || (etag !== undefined && current.etag !== etag)) return false;
    this.rows.set(key, { document: structuredClone(document) as JsonObject, etag: `W/"${++this.etag}"` });
    return true;
  }

  async query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
    const serviceId = parameters.find((parameter) => parameter.name === "@serviceId")?.value;
    const eventId = parameters.find((parameter) => parameter.name === "@eventId")?.value;
    return [...this.rows.entries()]
      .filter(([key, row]) =>
        key.startsWith(`${container}\u0000`) &&
        (!query.includes("IS_DEFINED(c.sortableUniqueId)") || typeof row.document.sortableUniqueId === "string") &&
        (partitionKey === undefined || row.document.serviceId === partitionKey) &&
        (serviceId === undefined || row.document.serviceId === serviceId) &&
        (eventId === undefined || row.document.id === eventId))
      .map(([, row]) => this.copy<T>(row));
  }

  eventRow(): JsonObject {
    const row = [...this.rows.entries()].find(([key, value]) =>
      key.startsWith(`${DEFAULT_COSMOS_CONTAINERS.events}\u0000`) && typeof value.document.sortableUniqueId === "string");
    if (row === undefined) throw new Error("actual Cosmos provider did not write its event row");
    return structuredClone(row[1].document);
  }
}

const testWithArtifact = artifact === undefined ? it.skip : it;

describe("SDT-G32 pinned C# runtime/provider parity", () => {
  testWithArtifact("uses real C# serialization/provider rows through TS import, replay, list-query, and provider round trips", async () => {
    const csharp = artifact!;
    const postgresLogical = logicalFromProvider(csharp.postgres, "postgres");
    const cosmosLogical = logicalFromProvider(csharp.cosmos, "cosmos");
    // DbEvent.FromEvent and CosmosEvent.FromEvent each own their real UTC
    // timestamp capture, and their Tags wire representations differ (json
    // string vs JSON array). Compare each provider to its own manifest-mapped
    // TS row below rather than fabricating a hand-written common record.
    expect(csharp.cosmos.pk).toBe(expectedPk(cosmosLogical));

    const d1 = database();
    await ensureG32Migration(d1);
    const d1Store = new D1EventStore(d1);
    await d1Store.initialize();
    const imported = sourceEnvelope(postgresLogical);
    expect((await d1Store.recordDelivery(imported, imported.enqueuedAt, "import")).kind).toBe("stored");

    // This is the actual source-provider replay API, not a reconstructed object.
    const replayed = await d1Store.readAllEvents(imported.serviceId, "");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      eventId: postgresLogical.id,
      suid: postgresLogical.sortableUniqueId,
      payload: postgresLogical.payload,
      eventType: postgresLogical.eventType,
    });

    const tag = eventTags(postgresLogical)[0]!;
    const identity = tagStateIdentityFrom(`${tag}:test-projector`).value;
    if (identity === undefined) throw new Error("C# provider tag is not a real registered list-query tag");
    const sourceTimestamp = Date.parse(String(postgresLogical.timestamp));
    expect(Number.isFinite(sourceTimestamp)).toBe(true);
    const projection = await new ProjectionRuntime(d1Store).catchUp(imported.serviceId, identity, sourceTimestamp + 120_001);
    expect(projection.appliedEvents).toBe(1);
    const listResponse = await handleSerializedQuery(new Request("https://g32-csharp-parity.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g9-test-service-id": imported.serviceId },
      body: JSON.stringify({ queryType: "GetTestListQuery", queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 10 }) }),
    }), { D1: d1 }, { store: d1Store });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json<{ itemsJson: string }>();
    expect(JSON.parse(listBody.itemsJson)).toContainEqual(JSON.parse(imported.payload));

    const d1Columns = manifest.logicalRecord.fields.map((field) => `${quoteIdentifier(field.d1)} AS ${quoteIdentifier(field.d1)}`).join(", ");
    const d1Row = await d1.prepare(
      `SELECT ${d1Columns} FROM ${quoteIdentifier(manifest.logicalRecord.table)} WHERE ${quoteIdentifier("ServiceId")} = ? AND ${quoteIdentifier("Id")} = ?`,
    ).bind(imported.serviceId, imported.eventId).first<JsonObject>();
    if (d1Row === null) throw new Error("actual TS D1 provider row was not stored");
    assertProviderRow(postgresLogical, d1Row, "d1");

    const cosmosClient = new CapturingCosmosClient();
    const cosmosProvider = createCosmosStoreProvider({ client: cosmosClient });
    const cosmosStore = cosmosProvider.create({});
    await cosmosStore.initialize();
    const cosmosImported = sourceEnvelope(cosmosLogical);
    expect((await cosmosStore.recordDelivery(cosmosImported, cosmosImported.enqueuedAt, "import")).kind).toBe("stored");
    const cosmosRow = cosmosClient.eventRow();
    assertProviderRow(cosmosLogical, cosmosRow, "cosmos");
    const expectedApplicationFields = new Set(manifest.cosmos.applicationFields);
    for (const field of expectedApplicationFields) expect(Object.hasOwn(cosmosRow, field), `actual Cosmos row omitted ${field}`).toBe(true);
    for (const field of manifest.cosmos.providerManagedReadonlyFields) {
      expect(cosmosRow[field] === undefined || cosmosRow[field] === null || typeof cosmosRow[field] === "string").toBe(true);
    }
    expect(cosmosRow.pk).toBe(expectedPk(cosmosLogical));

    // Marker is consumed by tools/sekiban-parity/run.mjs. It is emitted only
    // after real TS provider writes and the public list-query endpoint succeed.
    const tsProviderRows = Buffer.from(JSON.stringify({ postgres: d1Row, cosmos: cosmosRow })).toString("base64");
    console.log(`G32_PARITY_TS_PROVIDER_ROWS=${tsProviderRows}`);
  });
});

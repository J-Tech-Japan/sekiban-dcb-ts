import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

import { POSTGRES_STORE_PROVIDER } from "@sekiban/dcb-runtime";
import {
  CosmosClientError,
  CosmosEventStore,
  DEFAULT_COSMOS_CONTAINERS,
  createCosmosStoreProvider,
} from "@sekiban/dcb-runtime/cosmos";
import {
  assertCosmosManifestDocument,
  introspectPostgresEventStore,
  loadEventStoreManifest,
} from "./g32-ddl-introspection.mjs";

const POSTGRES_URL = process.env.POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb";
const requireRealCosmos = process.argv.includes("--require-real-cosmos");
const eventStoreManifest = loadEventStoreManifest();

async function configuredCosmosKey() {
  const keyFile = process.env.COSMOS_KEY_FILE;
  if (keyFile !== undefined) return (await readFile(keyFile, "utf8")).trim();
  return process.env.COSMOS_KEY;
}

function unique(prefix) {
  return `${prefix}-${randomUUID()}`;
}

const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000n;
const SUID_ID_MODULUS = 100000000000n;

function hash64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function g32Suid(value) {
  const text = String(value);
  if (/^[0-9]{30}$/.test(text)) return text;
  const hash = hash64(text);
  const ordinal = BigInt(/([0-9]+)$/.exec(text)?.[1] ?? Number(hash % 1000000n));
  const ticks = DOTNET_UNIX_EPOCH_TICKS + (ordinal % 1000000000n);
  return `${ticks.toString().padStart(19, "0")}${(hash % SUID_ID_MODULUS).toString().padStart(11, "0")}`;
}

function g32EventId(value) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return value;
  const high = hash64(`high:${value}`);
  const low = hash64(`low:${value}`);
  const bytes = new Uint8Array(16);
  let timestamp = high & 0xffffffffffffn;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | Number((high >> 48n) & 0x0fn);
  bytes[7] = Number((high >> 56n) & 0xffn);
  bytes[8] = 0x80 | Number((low >> 58n) & 0x3fn);
  for (let index = 9; index < 16; index += 1) bytes[index] = Number((low >> BigInt((index - 9) * 8)) & 0xffn);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function message(serviceId, eventId, suid, tag, eventTags, enqueuedAt = 1_000) {
  const id = g32EventId(eventId);
  return {
    version: 1,
    serviceId,
    allocatorLineageId: "store-contract-lineage",
    tag,
    attemptId: `${id}-attempt`,
    eventId: id,
    suid: g32Suid(suid),
    payload: JSON.stringify({ fixture: "payload" }),
    eventTags,
    eventType: "StoreContractEvent",
    provenance: "g32",
    timestamp: "2026-08-22T17:00:00.123Z",
    causationId: id,
    correlationId: "SerializedCommit",
    executedUser: "SerializedSekibanExecutor",
    enqueuedAt,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * An in-memory document client implements the same CAS/query seam as the REST
 * client. It is intentionally strict about partition keys and supports the
 * exact parameter predicates issued by CosmosEventStore.
 */
class MemoryCosmosClient {
  documents = new Map();
  nextEtag = 1;
  deleteCalls = 0;
  failAfterContainer;

  async initialize() {}

  key(container, partitionKey, id) {
    return `${container}\u0000${partitionKey}\u0000${id}`;
  }

  assertPartition(container, document, partitionKey) {
    if (container === DEFAULT_COSMOS_CONTAINERS.events) {
      // The C# logical record and the TS operational sidecars deliberately
      // share the event container.  That container is partitioned by /pk,
      // rather than /serviceId: a logical CosmosEvent uses serviceId|Id and
      // the service-scoped guards use their own reserved /pk value.  Require
      // the request header to agree with the persisted field so this memory
      // seam catches a real Cosmos partition mismatch instead of assuming
      // every document lives in an auxiliary /serviceId container.
      assert.equal(document.pk, partitionKey, "Cosmos event-container documents must use their persisted /pk partition");
      if (document.sortableUniqueId !== undefined) {
        assert.equal(
          document.pk,
          `${document.serviceId}|${document.id}`,
          "logical CosmosEvent records must use the exact C# ServiceId|Id partition",
        );
      }
      return;
    }
    assert.equal(document.serviceId, partitionKey, "Cosmos auxiliary documents must remain service-partitioned");
  }

  maybeFailAfter(container) {
    if (this.failAfterContainer !== container) return;
    this.failAfterContainer = undefined;
    throw new Error(`injected durable write failure for ${container}`);
  }

  async read(container, id, partitionKey) {
    const row = this.documents.get(this.key(container, partitionKey, id));
    return row === undefined ? undefined : { document: clone(row.document), etag: row.etag };
  }

  async create(container, document, partitionKey) {
    this.assertPartition(container, document, partitionKey);
    const key = this.key(container, partitionKey, document.id);
    if (this.documents.has(key)) throw new CosmosClientError(409, "duplicate document");
    const row = { document: clone(document), etag: `W/"${this.nextEtag++}"` };
    this.documents.set(key, row);
    this.maybeFailAfter(container);
    return { document: clone(row.document), etag: row.etag };
  }

  async replace(container, document, partitionKey, etag) {
    this.assertPartition(container, document, partitionKey);
    const key = this.key(container, partitionKey, document.id);
    const row = this.documents.get(key);
    if (row === undefined) return false;
    if (etag !== undefined && row.etag !== etag) return false;
    const next = { document: clone(document), etag: `W/"${this.nextEtag++}"` };
    this.documents.set(key, next);
    this.maybeFailAfter(container);
    return true;
  }

  async delete(container, id, partitionKey) {
    this.deleteCalls += 1;
    return this.documents.delete(this.key(container, partitionKey, id));
  }

  async query(container, query, parameters, partitionKey) {
    const serviceId = parameters.find((parameter) => parameter.name === "@serviceId")?.value;
    const eventId = parameters.find((parameter) => parameter.name === "@eventId")?.value;
    const rows = [];
    for (const row of this.documents.values()) {
      if (row.document.__container !== undefined && row.document.__container !== container) continue;
      if (row.document.serviceId === undefined) continue;
      const documentPartition = typeof row.document.pk === "string" ? row.document.pk : row.document.serviceId;
      if (partitionKey !== undefined && documentPartition !== partitionKey) continue;
      if (serviceId !== undefined && row.document.serviceId !== serviceId) continue;
      if (eventId !== undefined && row.document.eventId !== eventId) continue;
      // CosmosEventStore deliberately keeps operational sidecars in the
      // event container, and its event scan explicitly excludes them with
      // IS_DEFINED(c.sortableUniqueId).  The memory seam must honor that SQL
      // predicate or it would turn a provider-only shape bug into a green
      // local contract run.
      if (query.includes("IS_DEFINED(c.sortableUniqueId)") && row.document.sortableUniqueId === undefined) continue;
      const keyContainer = row.document.__container ?? container;
      if (keyContainer !== container) continue;
      rows.push({ document: clone(row.document), etag: row.etag });
    }
    return rows;
  }

  get documentCount() {
    return this.documents.size;
  }
}

function logicalCosmosDocuments(client) {
  return [...client.documents.values()]
    .map((entry) => Object.fromEntries(Object.entries(entry.document).filter(([key]) => key !== "__container")))
    .filter((document) => document.sortableUniqueId !== undefined);
}

function assertCosmosLogicalRecordContract(client, label) {
  const documents = logicalCosmosDocuments(client);
  assert.ok(documents.length > 0, `${label}: expected a persisted logical CosmosEvent document`);
  for (const document of documents) {
    assertCosmosManifestDocument(eventStoreManifest, document);
  }
}

async function assertPostgresLogicalRecordContract(connectionString = POSTGRES_URL) {
  const sql = postgres(connectionString);
  try {
    await introspectPostgresEventStore(sql, eventStoreManifest);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function freshSchemaName() {
  return `g32_contract_${randomUUID().replaceAll("-", "")}`;
}

async function withFreshPostgresSchema(run) {
  const admin = postgres(POSTGRES_URL);
  const schema = freshSchemaName();
  try {
    // Every name is generated locally and contains only [a-z0-9_], so this
    // isolated schema can never target a deployed service's data.
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(POSTGRES_URL);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    return await run(scoped.toString());
  } finally {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 5 });
  }
}

// The adapter does not persist this implementation-only marker; it keeps the
// memory fixture from accidentally returning rows from another container.
const memoryCreate = MemoryCosmosClient.prototype.create;
MemoryCosmosClient.prototype.create = async function create(container, document, partitionKey) {
  return memoryCreate.call(this, container, { ...document, __container: container }, partitionKey);
};
const memoryReplace = MemoryCosmosClient.prototype.replace;
MemoryCosmosClient.prototype.replace = async function replace(container, document, partitionKey, etag) {
  return memoryReplace.call(this, container, { ...document, __container: container }, partitionKey, etag);
};

export async function runPipelineContract(label, makeStore) {
  const serviceId = unique(`${label}-service`);
  const tagA = `${label}:a:${randomUUID()}`;
  const tagB = `${label}:b:${randomUUID()}`;
  const eventTags = [tagA, tagB].sort();
  const first = message(serviceId, unique(`${label}-first`), "1", tagA, eventTags);
  const second = message(serviceId, unique(`${label}-second`), "2", tagB, eventTags);
  const store = await makeStore();

  await store.recordDelivery(first, 1_100);
  await store.recordDelivery(second, 2_100);
  const events = await store.readAllEvents(serviceId, "");
  assert.deepEqual(events.map((event) => event.suid), [first.suid, second.suid], `${label}: SUID ordering must be bytewise and deterministic`);
  assert.deepEqual(await store.readAllEvents(serviceId, first.suid).then((rows) => rows.map((event) => event.eventId)), [second.eventId]);

  await store.recordDelivery({ ...first, enqueuedAt: 900 }, 1_300);
  const deduplicated = (await store.readAllEvents(serviceId, "")).find((event) => event.eventId === first.eventId);
  assert.ok(deduplicated);
  assert.equal(deduplicated.arrivals.length, 1, `${label}: duplicate EventId/tag delivery must not duplicate arrivals`);
  assert.equal(deduplicated.maxDeliveryLagMs, 400);
  await assert.rejects(
    store.recordDelivery({ ...first, payload: JSON.stringify({ fixture: "conflict" }) }, 1_400),
    /conflicts/,
    `${label}: unequal EventId payload must fail closed`,
  );
  assert.deepEqual(await store.listProjectionTags(serviceId), eventTags);
  assert.equal(await store.currentLagBound(serviceId, 2_100), 1_100);

  const pending = await store.upsertPending({ ...first, tag: tagA }, 3_000, 20_000);
  assert.deepEqual(pending.observedPaths, [tagA]);
  const mergedPending = await store.upsertPending({ ...first, tag: tagB }, 3_500, 25_000);
  assert.deepEqual(mergedPending.expectedPaths, eventTags);
  assert.deepEqual(mergedPending.observedPaths, eventTags);
  assert.equal((await store.listPending(serviceId)).length, 1);

  const finding = {
    serviceId,
    eventId: first.eventId,
    path: tagB,
    classification: "MISSING_STABLE",
    firstObservedAt: 3_000,
    lagBoundMs: 25_000,
    observedAt: 30_000,
  };
  await store.appendFinding(finding);
  await store.appendFinding(finding);
  assert.equal(await store.hasFinding(serviceId, finding.eventId, finding.path, finding.classification), true);
  assert.equal((await store.listFindings(serviceId, finding.eventId)).length, 1);

  const projectionId = unique(`${label}-projection`);
  const initialCheckpoint = {
    serviceId,
    projectionId,
    expectedLastSuid: null,
    lastSuid: first.suid,
    stateJson: JSON.stringify({ applied: [first.eventId] }),
    version: 1,
    updatedAt: 31_000,
  };
  assert.equal(await store.advanceProjectionCheckpoint(initialCheckpoint), true);
  const beforeStale = await store.readProjectionCheckpoint(serviceId, projectionId);
  assert.deepEqual(beforeStale, {
    serviceId,
    projectionId,
    lastSuid: initialCheckpoint.lastSuid,
    stateJson: initialCheckpoint.stateJson,
    version: initialCheckpoint.version,
    updatedAt: initialCheckpoint.updatedAt,
  });
  assert.equal(await store.advanceProjectionCheckpoint({
    ...initialCheckpoint,
    expectedLastSuid: g32Suid("stale"),
    lastSuid: second.suid,
    stateJson: JSON.stringify({ applied: [first.eventId, second.eventId] }),
    version: 2,
  }), false);
  assert.deepEqual(await store.readProjectionCheckpoint(serviceId, projectionId), beforeStale);
  assert.deepEqual(await store.projectionLag(serviceId, projectionId, tagA), {
    serviceId,
    projectionId,
    tag: tagA,
    checkpointSuid: first.suid,
    headSuid: second.suid,
    behindEvents: 1,
  });
  assert.equal(await store.advanceProjectionCheckpoint({
    ...initialCheckpoint,
    expectedLastSuid: first.suid,
    lastSuid: second.suid,
    stateJson: JSON.stringify({ applied: [first.eventId, second.eventId] }),
    version: 2,
    updatedAt: 32_000,
  }), true);
  assert.equal((await store.projectionLag(serviceId, projectionId, tagA)).behindEvents, 0);

  return { store, serviceId, first, second };
}

export async function runFaultSuite() {
  const boundaries = [
    ["event", DEFAULT_COSMOS_CONTAINERS.events],
    ["lag", DEFAULT_COSMOS_CONTAINERS.lagEstimates],
    ["pending", DEFAULT_COSMOS_CONTAINERS.pendingArrivals],
    ["finding", DEFAULT_COSMOS_CONTAINERS.findings],
  ];
  for (const [boundary, container] of boundaries) {
    const client = new MemoryCosmosClient();
    const store = new CosmosEventStore({ client });
    await store.initialize();
    const serviceId = unique(`fault-${boundary}`);
    const tag = `${boundary}:tag:${randomUUID()}`;
    const entry = message(serviceId, unique(`fault-${boundary}-event`), `fault-${boundary}`, tag, [tag]);
    client.failAfterContainer = container;
    if (boundary === "event" || boundary === "lag") {
      await assert.rejects(store.recordDelivery(entry, 2_000), /injected durable write failure/);
      client.failAfterContainer = undefined;
      await store.recordDelivery(entry, 2_000);
      assert.equal((await store.readAllEvents(serviceId, "")).length, 1);
    } else if (boundary === "pending") {
      await assert.rejects(store.upsertPending(entry, 2_000, 20_000), /injected durable write failure/);
      client.failAfterContainer = undefined;
      await store.upsertPending(entry, 2_000, 20_000);
      assert.equal((await store.listPending(serviceId)).length, 1);
    } else {
      const finding = {
        serviceId,
        eventId: entry.eventId,
        path: tag,
        classification: "MISSING_STABLE",
        firstObservedAt: 2_000,
        lagBoundMs: 20_000,
        observedAt: 22_000,
      };
      await assert.rejects(store.appendFinding(finding), /injected durable write failure/);
      client.failAfterContainer = undefined;
      await store.appendFinding(finding);
      assert.equal((await store.listFindings(serviceId)).length, 1);
    }
    assert.equal(client.deleteCalls, 0, `${boundary}: adapter must never delete a durable document while recovering`);
    assert.ok(client.documentCount > 0, `${boundary}: durable documents must survive the injected failure`);
  }

  const client = new MemoryCosmosClient();
  const store = new CosmosEventStore({ client });
  await store.initialize();
  const serviceId = unique("fault-checkpoint");
  const projectionId = unique("fault-checkpoint-projection");
  const initial = {
    serviceId,
    projectionId,
    expectedLastSuid: null,
    lastSuid: g32Suid("1"),
    stateJson: JSON.stringify({ applied: ["one"] }),
    version: 1,
    updatedAt: 1,
  };
  assert.equal(await store.advanceProjectionCheckpoint(initial), true);
  const next = { ...initial, expectedLastSuid: g32Suid("1"), lastSuid: g32Suid("2"), stateJson: JSON.stringify({ applied: ["one", "two"] }), version: 2, updatedAt: 2 };
  client.failAfterContainer = DEFAULT_COSMOS_CONTAINERS.checkpoints;
  await assert.rejects(store.advanceProjectionCheckpoint(next), /injected durable write failure/);
  client.failAfterContainer = undefined;
  // The write did commit before the injected acknowledgement failure. A
  // replay with the old expected position is therefore a safe CAS miss, and
  // the durable target state—not a deletion or rollback—is the convergence
  // oracle.
  assert.equal(await store.advanceProjectionCheckpoint(next), false);
  expectCheckpoint(await store.readProjectionCheckpoint(serviceId, projectionId), next);
  assert.equal(client.deleteCalls, 0);
  console.log("SDT-G12 fault suite passed: event, lag, pending, finding, and checkpoint failures redeliver without deletion");
}

function expectCheckpoint(actual, expected) {
  assert.deepEqual(actual, {
    serviceId: expected.serviceId,
    projectionId: expected.projectionId,
    lastSuid: expected.lastSuid,
    stateJson: expected.stateJson,
    version: expected.version,
    updatedAt: expected.updatedAt,
  });
}

async function main() {
  if (!requireRealCosmos) {
    await withFreshPostgresSchema(async (connectionString) => {
      const store = POSTGRES_STORE_PROVIDER.create({ POSTGRES_URL: connectionString });
      try {
        await store.initialize();
        await assertPostgresLogicalRecordContract(connectionString);
        await runPipelineContract("postgres", async () => store);
      } finally {
        await store.close();
      }
    });
  }

  const memoryCosmosClient = new MemoryCosmosClient();
  const memoryCosmosStore = new CosmosEventStore({ client: memoryCosmosClient });
  await memoryCosmosStore.initialize();
  await runPipelineContract("cosmos-memory", async () => memoryCosmosStore);
  // The same provider document construction used by the real REST client is
  // compared field-for-field with the independent C# manifest after actual
  // PipelineStore writes, not a hand-written document shape.
  assertCosmosLogicalRecordContract(memoryCosmosClient, "cosmos-memory");

  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = await configuredCosmosKey();
  const database = process.env.COSMOS_DATABASE;
  if (requireRealCosmos && (endpoint === undefined || key === undefined || database === undefined)) {
    throw new Error("COSMOS_ENDPOINT, COSMOS_KEY, and COSMOS_DATABASE are required for the emulator lane");
  }
  if (endpoint !== undefined || key !== undefined || database !== undefined) {
    if (endpoint === undefined || key === undefined || database === undefined) {
      throw new Error("Cosmos configuration must be complete; refusing a partial or skipped lane");
    }
    await runPipelineContract("cosmos-emulator", async () => {
      const provider = createCosmosStoreProvider({ endpoint, key, database });
      const store = provider.create({});
      await store.initialize();
      return store;
    });
    console.log("SDT-G12 real Cosmos contract passed: same shared assertions ran against the configured emulator/account");
  }

  await runFaultSuite();
  console.log(`SDT-G18 shared PipelineStore contract passed${requireRealCosmos ? " (emulator lane)" : " (Postgres + memory Cosmos)"}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  // Postgres keeps an idle connection open by design; this script is a finite
  // verification command, so terminate only after every assertion has completed.
  process.exit(0);
}

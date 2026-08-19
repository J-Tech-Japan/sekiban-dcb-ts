import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { POSTGRES_STORE_PROVIDER } from "@sekiban/dcb-runtime";
import {
  CosmosClientError,
  CosmosEventStore,
  DEFAULT_COSMOS_CONTAINERS,
  createCosmosStoreProvider,
} from "@sekiban/dcb-runtime/cosmos";

const POSTGRES_URL = process.env.POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb";
const requireRealCosmos = process.argv.includes("--require-real-cosmos");

async function configuredCosmosKey() {
  const keyFile = process.env.COSMOS_KEY_FILE;
  if (keyFile !== undefined) return (await readFile(keyFile, "utf8")).trim();
  return process.env.COSMOS_KEY;
}

function unique(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function message(serviceId, eventId, suid, tag, eventTags, enqueuedAt = 1_000) {
  return {
    version: 1,
    serviceId,
    tag,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    payload: "cGF5bG9hZA==",
    eventTags,
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

  assertPartition(document, partitionKey) {
    assert.equal(document.serviceId, partitionKey, "Cosmos documents must remain service-partitioned");
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
    this.assertPartition(document, partitionKey);
    const key = this.key(container, partitionKey, document.id);
    if (this.documents.has(key)) throw new CosmosClientError(409, "duplicate document");
    const row = { document: clone(document), etag: `W/"${this.nextEtag++}"` };
    this.documents.set(key, row);
    this.maybeFailAfter(container);
    return { document: clone(row.document), etag: row.etag };
  }

  async replace(container, document, partitionKey, etag) {
    this.assertPartition(document, partitionKey);
    const key = this.key(container, partitionKey, document.id);
    const row = this.documents.get(key);
    if (row === undefined) return false;
    if (etag !== undefined && row.etag !== etag) return false;
    const next = { document: clone(document), etag: `W/"${this.nextEtag++}"` };
    this.documents.set(key, next);
    this.maybeFailAfter(container);
    return true;
  }

  async query(container, _query, parameters, partitionKey) {
    const serviceId = parameters.find((parameter) => parameter.name === "@serviceId")?.value;
    const eventId = parameters.find((parameter) => parameter.name === "@eventId")?.value;
    const rows = [];
    for (const row of this.documents.values()) {
      if (row.document.__container !== undefined && row.document.__container !== container) continue;
      if (row.document.serviceId === undefined) continue;
      if (partitionKey !== undefined && row.document.serviceId !== partitionKey) continue;
      if (serviceId !== undefined && row.document.serviceId !== serviceId) continue;
      if (eventId !== undefined && row.document.eventId !== eventId) continue;
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

async function runPipelineContract(label, makeStore) {
  const serviceId = unique(`${label}-service`);
  const tagA = `${label}:a:${randomUUID()}`;
  const tagB = `${label}:b:${randomUUID()}`;
  const eventTags = [tagA, tagB].sort();
  const first = message(serviceId, unique(`${label}-first`), "suid-10", tagA, eventTags);
  const second = message(serviceId, unique(`${label}-second`), "suid-2", tagB, eventTags);
  const store = await makeStore();

  await store.recordDelivery(first, 1_100);
  await store.recordDelivery(second, 2_100);
  const events = await store.readAllEvents(serviceId, "");
  assert.deepEqual(events.map((event) => event.suid), ["suid-10", "suid-2"], `${label}: SUID ordering must be bytewise and deterministic`);
  assert.deepEqual(await store.readAllEvents(serviceId, "suid-10").then((rows) => rows.map((event) => event.eventId)), [second.eventId]);

  await store.recordDelivery({ ...first, enqueuedAt: 900 }, 1_300);
  const deduplicated = (await store.readAllEvents(serviceId, "")).find((event) => event.eventId === first.eventId);
  assert.ok(deduplicated);
  assert.equal(deduplicated.arrivals.length, 1, `${label}: duplicate EventId/tag delivery must not duplicate arrivals`);
  assert.equal(deduplicated.maxDeliveryLagMs, 400);
  await assert.rejects(
    store.recordDelivery({ ...first, payload: "Y29uZmxpY3Q=" }, 1_400),
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
    expectedLastSuid: "stale-suid",
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

async function runFaultSuite() {
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
    const entry = message(serviceId, unique(`fault-${boundary}-event`), `suid-${boundary}`, tag, [tag]);
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
    lastSuid: "suid-1",
    stateJson: JSON.stringify({ applied: ["one"] }),
    version: 1,
    updatedAt: 1,
  };
  assert.equal(await store.advanceProjectionCheckpoint(initial), true);
  const next = { ...initial, expectedLastSuid: "suid-1", lastSuid: "suid-2", stateJson: JSON.stringify({ applied: ["one", "two"] }), version: 2, updatedAt: 2 };
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
    await runPipelineContract("postgres", async () => {
      const store = POSTGRES_STORE_PROVIDER.create({ POSTGRES_URL });
      await store.initialize();
      return store;
    });
  }

  await runPipelineContract("cosmos-memory", async () => {
    const store = new CosmosEventStore({ client: new MemoryCosmosClient() });
    await store.initialize();
    return store;
  });

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
  console.log(`SDT-G12 shared PipelineStore contract passed${requireRealCosmos ? " (emulator lane)" : " (Postgres + memory Cosmos)"}`);
}

await main();
// Postgres keeps an idle connection open by design; this script is a finite
// verification command, so terminate only after every assertion has completed.
process.exit(0);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createCosmosBootstrapAdapter, CosmosEventStore } from "@sekiban/dcb-runtime/cosmos";

const requireRealCosmos = process.argv.includes("--require-real-cosmos");
const endpoint = process.env.COSMOS_ENDPOINT;
const database = process.env.COSMOS_DATABASE;
const key = process.env.COSMOS_KEY_FILE === undefined
  ? process.env.COSMOS_KEY
  : (await readFile(process.env.COSMOS_KEY_FILE, "utf8")).trim();

if (requireRealCosmos && (endpoint === undefined || database === undefined || key === undefined)) {
  throw new Error("COSMOS_ENDPOINT, COSMOS_DATABASE, and COSMOS_KEY_FILE/COSMOS_KEY are required for the real Cosmos bootstrap contract");
}

const suid = (value) => `suid-${String(value).padStart(32, "0")}`;
function message(serviceId, eventId, value, tags) {
  return {
    version: 1,
    serviceId,
    allocatorLineageId: "g22-bootstrap-provider-lineage",
    tag: tags[0],
    attemptId: `g22-bootstrap:${eventId}`,
    eventId,
    suid: suid(value),
    payload: value === 1 ? "AQ==" : "Ag==",
    eventTags: tags,
    provenance: "pre-g27-queue",
    enqueuedAt: 0,
  };
}
function canonicalMessage(serviceId, eventId, value, tags) {
  return { ...message(serviceId, eventId, value, tags), eventType: "OrderPlaced:2", provenance: "g27" };
}
async function snapshot(store, serviceId) {
  return {
    events: await store.readAllEvents(serviceId, ""),
    projectionTags: await store.listProjectionTags(serviceId),
    lag: await store.currentLagBound(serviceId, 0),
    pending: await store.listPending(serviceId),
    findings: await store.listFindings(serviceId),
    incidents: await store.listDeliveryIncidents(serviceId),
  };
}

const store = new CosmosEventStore({ endpoint, database, key });
await store.initialize();
const suffix = randomUUID();
const sourceServiceId = `g22-cosmos-source-${suffix}`;
const targetServiceId = `g22-cosmos-target-${suffix}`;
const tags = [`g22:cosmos:orders:${suffix}`, `g22:cosmos:audit:${suffix}`].sort();

await store.recordDelivery(message(sourceServiceId, "first", 1, tags), 0);
await store.recordDelivery(message(sourceServiceId, "second", 2, tags), 0);
const adapter = createCosmosBootstrapAdapter(store);
const first = await adapter.exportPage({ sourceServiceId, targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 1 });
await store.recordDelivery(message(sourceServiceId, "late-after-watermark", 3, tags), 0);
const resumed = await adapter.exportPage({ sourceServiceId, targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 1, cursor: first.cursor });
assert.equal(resumed.dump.manifest.contentDigest, first.dump.manifest.contentDigest, "Cosmos export resume must retain its fixed high watermark");
assert.deepEqual(resumed.dump.events.map((event) => event.eventId), ["first", "second"]);
assert.deepEqual(resumed.page.map((event) => event.eventId), ["second"]);

await store.recordDelivery(message(targetServiceId, "same", 1, tags), 0);
const targetDump = (await adapter.exportPage({ sourceServiceId: targetServiceId, targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 8 })).dump;
await adapter.admitBootstrap({ importId: "g22-cosmos-replay", leaseEpoch: 1, manifest: targetDump.manifest, events: targetDump.events });
const before = await snapshot(store, targetServiceId);
await assert.rejects(
  adapter.admitBootstrap({ importId: "g22-cosmos-conflict", leaseEpoch: 2, manifest: targetDump.manifest, events: [{ ...targetDump.events[0], payload: "Aw==" }] }),
  (error) => error?.code === "BOOTSTRAP_EVENT_IDENTITY_CONFLICT",
);
assert.deepEqual(await snapshot(store, targetServiceId), before, "Cosmos rejected bootstrap admission must not change event/metadata/detector/lag state");

const canonical = canonicalMessage(sourceServiceId, "canonical", 4, tags);
await store.recordDelivery(canonical, 0);
const canonicalDump = (await adapter.exportPage({ sourceServiceId, targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 8 })).dump;
await adapter.admitBootstrap({ importId: "g22-cosmos-canonical-replay", leaseEpoch: 3, manifest: canonicalDump.manifest, events: canonicalDump.events.filter((event) => event.eventId === "canonical") });
const canonicalBefore = await snapshot(store, targetServiceId);
const directDivergence = { ...canonical, serviceId: targetServiceId, eventType: "OrderPlaced:1" };
await assert.rejects(
  store.recordDelivery(directDivergence, 0),
  (error) => error?.code === "CANONICAL_EVENT_IDENTITY_CONFLICT",
);
assert.deepEqual(await snapshot(store, targetServiceId), canonicalBefore, "Cosmos direct canonical-key divergence must fail before any durable side effect");
await assert.rejects(
  adapter.admitBootstrap({ importId: "g22-cosmos-canonical-divergence", leaseEpoch: 4, manifest: canonicalDump.manifest, events: [{ ...canonicalDump.events.find((event) => event.eventId === "canonical"), eventType: "OrderPlaced:1" }] }),
  (error) => error?.code === "BOOTSTRAP_EVENT_IDENTITY_CONFLICT",
);
console.log("SDT-G22 real Cosmos bootstrap provider contract passed: export snapshot, direct store identity guard, and adapter guard");

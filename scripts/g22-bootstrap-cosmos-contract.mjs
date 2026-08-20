import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { BootstrapIdentityConflictError, createBootstrapStoreAdapter } from "@sekiban/dcb-runtime";
import { CosmosEventStore } from "@sekiban/dcb-runtime/cosmos";

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
    enqueuedAt: 0,
  };
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
const adapter = createBootstrapStoreAdapter("cosmos", store);
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
  BootstrapIdentityConflictError,
);
assert.deepEqual(await snapshot(store, targetServiceId), before, "Cosmos rejected bootstrap admission must not change event/metadata/detector/lag state");
console.log("SDT-G22 real Cosmos bootstrap provider contract passed: export snapshot and store admission identity guard");

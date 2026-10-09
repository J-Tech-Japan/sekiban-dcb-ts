import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DOTNET_UNIX_EPOCH_TICKS,
  formatSortableUniqueId,
  serializedEventMetadata,
} from "@sekiban/dcb-runtime";
import { createCosmosBootstrapAdapter, CosmosEventStore } from "@sekiban/dcb-runtime/cosmos";

const G32_TIMESTAMP = "2026-08-22T17:00:00.123Z";
const requireRealCosmos = process.argv.includes("--require-real-cosmos");
const selfTest = process.argv.includes("--self-test");

/**
 * The real-Cosmos contract deliberately constructs its own deterministic G32
 * values. The fixture must not acquire an ID through the store under test.
 */
function g32Suid(value) {
  return formatSortableUniqueId(
    DOTNET_UNIX_EPOCH_TICKS + BigInt(value) * 10_000n,
    BigInt(value),
  );
}

function g32EventId(label) {
  const bytes = createHash("sha256").update(`g22-real-cosmos:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Positive bootstrap rows use only the G32 durable envelope. */
function message(serviceId, eventLabel, value, tags) {
  const eventId = g32EventId(eventLabel);
  const metadata = serializedEventMetadata(eventId);
  return {
    version: 1,
    serviceId,
    allocatorLineageId: "g22-bootstrap-provider-lineage",
    tag: tags[0],
    attemptId: `g22-bootstrap:${eventLabel}`,
    eventId,
    suid: g32Suid(value),
    payload: JSON.stringify({ value }),
    eventTags: tags,
    eventType: "OrderPlaced",
    // This is the fixed internal G32 provenance, not a caller-selected or
    // legacy provenance lane.
    provenance: "g32",
    timestamp: G32_TIMESTAMP,
    causationId: metadata.causationId,
    correlationId: metadata.correlationId,
    executedUser: metadata.executedUser,
    enqueuedAt: 0,
  };
}

function zeroCallClient(calls) {
  const unexpected = (operation) => async () => {
    calls.push(operation);
    throw new Error(`legacy ingress reached Cosmos client ${operation}`);
  };
  return {
    initialize: async () => {},
    read: unexpected("read"),
    create: unexpected("create"),
    replace: unexpected("replace"),
    query: unexpected("query"),
  };
}

/**
 * Keep obsolete forms as an explicit fail-closed negative lane. `initialize`
 * is completed before every probe, then every client call is attributable to
 * the probe itself and must remain zero.
 */
async function assertLegacyIngressRejectsBeforeCosmosClient() {
  const calls = [];
  const store = new CosmosEventStore({ client: zeroCallClient(calls) });
  await store.initialize();
  const valid = message("g22-cosmos-negative", "negative-base", 9, ["g22:negative"]);
  assert.equal(Object.hasOwn(valid, "eventPayloadVersion"), false, "G32 positive envelope must not carry caller-selected version");
  const oldSuid = "suid-00000000000000000001787414836102";
  const cases = [
    ["old-37-character-suid", { ...valid, suid: oldSuid }, "SUID_LEGACY_FORMAT_RETIRED"],
    ["legacy-provenance", { ...valid, provenance: "pre-g27-queue" }, "DELIVERY_IDENTITY_INVALID"],
    ["identity-less", { ...valid, eventType: undefined }, "MISSING_CANONICAL_EVENT_IDENTITY"],
  ];
  for (const [name, candidate, expectedCode] of cases) {
    calls.length = 0;
    await assert.rejects(
      store.recordDelivery(candidate, 0),
      (error) => error !== null && typeof error === "object" && error.code === expectedCode,
      `${name} must be a typed admission rejection`,
    );
    assert.deepEqual(calls, [], `${name} must be rejected before a Cosmos client call`);
  }
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

if (selfTest) {
  await assertLegacyIngressRejectsBeforeCosmosClient();
  const positive = message("g22-self-test", "positive", 1, ["g22:self-test"]);
  assert.match(positive.suid, /^[0-9]{30}$/);
  assert.match(positive.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(positive.eventType, "OrderPlaced");
  console.log("SDT-G22 Cosmos G32 fixture self-test passed: positive G32 envelope and legacy zero-call negatives");
} else {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const database = process.env.COSMOS_DATABASE;
  const key = process.env.COSMOS_KEY_FILE === undefined
    ? process.env.COSMOS_KEY
    : (await readFile(process.env.COSMOS_KEY_FILE, "utf8")).trim();

  if (requireRealCosmos && (endpoint === undefined || database === undefined || key === undefined)) {
    throw new Error("COSMOS_ENDPOINT, COSMOS_DATABASE, and COSMOS_KEY_FILE/COSMOS_KEY are required for the real Cosmos bootstrap contract");
  }

  await assertLegacyIngressRejectsBeforeCosmosClient();
  const store = new CosmosEventStore({ endpoint, database, key });
  await store.initialize();
  const suffix = randomUUID();
  const sourceServiceId = `g22-cosmos-source-${suffix}`;
  const targetServiceId = `g22-cosmos-target-${suffix}`;
  const tags = [`g22:cosmos:orders:${suffix}`, `g22:cosmos:audit:${suffix}`].sort();

  await store.recordDelivery(message(sourceServiceId, "first", 1, tags), 0);
  await store.recordDelivery(message(sourceServiceId, "second", 2, tags), 0);
  const adapter = createCosmosBootstrapAdapter(store);
  const first = await adapter.exportPage({ sourceServiceId, sourceAllocatorLineageId: "g22-bootstrap-provider-lineage", targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 1 });
  await store.recordDelivery(message(sourceServiceId, "late-after-watermark", 3, tags), 0);
  const resumed = await adapter.exportPage({ sourceServiceId, sourceAllocatorLineageId: "g22-bootstrap-provider-lineage", targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 1, cursor: first.cursor });
  assert.equal(resumed.dump.manifest.contentDigest, first.dump.manifest.contentDigest, "Cosmos export resume must retain its fixed high watermark");
  assert.deepEqual(resumed.dump.events.map((event) => event.eventId), [g32EventId("first"), g32EventId("second")]);
  assert.deepEqual(resumed.page.map((event) => event.eventId), [g32EventId("second")]);

  await store.recordDelivery(message(targetServiceId, "same", 1, tags), 0);
  const targetDump = (await adapter.exportPage({ sourceServiceId: targetServiceId, sourceAllocatorLineageId: "g22-bootstrap-provider-lineage", targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 8 })).dump;
  await adapter.admitBootstrap({ importId: "g22-cosmos-replay", leaseEpoch: 1, manifest: targetDump.manifest, events: targetDump.events });
  await adapter.verifyBootstrap({ importId: "g22-cosmos-replay", manifest: targetDump.manifest });
  const initialTargetEvents = await store.readAllEvents(targetServiceId, "");
  assert.equal(initialTargetEvents.length, 1, "Cosmos bootstrap target count after replay must be exact");
  assert.deepEqual(initialTargetEvents.map((event) => event.eventId), [g32EventId("same")], "Cosmos bootstrap target ids after replay must be exact");
  const before = await snapshot(store, targetServiceId);
  await assert.rejects(
    adapter.admitBootstrap({ importId: "g22-cosmos-conflict", leaseEpoch: 2, manifest: targetDump.manifest, events: [{ ...targetDump.events[0], payload: JSON.stringify({ value: 3 }) }] }),
    (error) => error?.code === "BOOTSTRAP_EVENT_IDENTITY_CONFLICT",
  );
  assert.deepEqual(await snapshot(store, targetServiceId), before, "Cosmos rejected bootstrap admission must not change event/metadata/detector/lag state");

  const canonical = message(sourceServiceId, "canonical", 4, tags);
  await store.recordDelivery(canonical, 0);
  const canonicalDump = (await adapter.exportPage({ sourceServiceId, sourceAllocatorLineageId: "g22-bootstrap-provider-lineage", targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 8 })).dump;
  await adapter.admitBootstrap({ importId: "g22-cosmos-canonical-replay", leaseEpoch: 3, manifest: canonicalDump.manifest, events: canonicalDump.events.filter((event) => event.eventId === g32EventId("canonical")) });
  const finalTargetDump = (await adapter.exportPage({ sourceServiceId: targetServiceId, sourceAllocatorLineageId: "g22-bootstrap-provider-lineage", targetServiceId, allocatorLineageId: "g22-bootstrap-provider-lineage", pageSize: 8 })).dump;
  await adapter.verifyBootstrap({ importId: "g22-cosmos-canonical-replay", manifest: finalTargetDump.manifest });
  const finalTargetEvents = await store.readAllEvents(targetServiceId, "");
  assert.equal(finalTargetEvents.length, 2, "Cosmos bootstrap target count after canonical replay must be exact");
  assert.deepEqual(
    finalTargetEvents.map((event) => event.eventId).sort(),
    [g32EventId("canonical"), g32EventId("same")].sort(),
    "Cosmos bootstrap target ids after canonical replay must be exact",
  );
  const canonicalBefore = await snapshot(store, targetServiceId);
  const directDivergence = { ...canonical, serviceId: targetServiceId, eventType: "OrderPlacedRenamed" };
  await assert.rejects(
    store.recordDelivery(directDivergence, 0),
    (error) => error?.code === "CANONICAL_EVENT_IDENTITY_CONFLICT",
  );
  assert.deepEqual(await snapshot(store, targetServiceId), canonicalBefore, "Cosmos direct canonical-key divergence must fail before any durable side effect");
  await assert.rejects(
    adapter.admitBootstrap({ importId: "g22-cosmos-canonical-divergence", leaseEpoch: 4, manifest: canonicalDump.manifest, events: [{ ...canonicalDump.events.find((event) => event.eventId === g32EventId("canonical")), eventType: "OrderPlacedRenamed" }] }),
    (error) => error?.code === "BOOTSTRAP_EVENT_IDENTITY_CONFLICT",
  );
  console.log("SDT-G22 real Cosmos bootstrap provider contract passed: G32 positive bootstrap, legacy zero-call gates, and canonical identity guards");
}

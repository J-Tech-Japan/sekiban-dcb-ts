#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function requestJson(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers, cache: "no-store" });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { status: response.status, body, raw };
}

async function retryConformance(read, { attempts = 1, delayMs = 0 } = {}) {
  let latest;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = await read();
    if (latest.status === 200) return latest;
    if (attempt < attempts && (latest.status === 403 || latest.status === 404)) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    break;
  }
  return latest;
}

function d1Rows(database, command, wrangler) {
  const raw = execFileSync(wrangler, ["d1", "execute", database, "--remote", "--command", command, "--json"], { cwd: root, encoding: "utf8" });
  const parsed = JSON.parse(raw);
  const results = Array.isArray(parsed) ? parsed.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []) : [];
  return results;
}

function resourceListing(wrangler) {
  const d1 = JSON.parse(execFileSync(wrangler, ["d1", "list", "--json"], { cwd: root, encoding: "utf8" }));
  const queues = execFileSync(wrangler, ["queues", "list"], { cwd: root, encoding: "utf8" });
  return { d1, queues: queues.trim() };
}

function expectedContract() {
  const contract = readJson("contracts/g32-cutover.json");
  if (contract?.task !== "SDT-G32") throw new Error("G32 cutover contract is invalid");
  return contract;
}

function numberAt(rows, name) {
  const value = rows[0]?.[name];
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`G32 D1 inventory ${name} is invalid`);
  return number;
}

export function capturePreWitness(contract, wrangler) {
  const oldPipeline = d1Rows(contract.bridge.oldPipelineDatabaseId,
    "SELECT (SELECT COUNT(*) FROM serialized_dcb_events WHERE service_id = 'g25-38219c8-20260820f') AS events, (SELECT COUNT(*) FROM serialized_dcb_pending_arrivals WHERE service_id = 'g25-38219c8-20260820f') AS pending, (SELECT COUNT(*) FROM serialized_dcb_delivery_incidents WHERE service_id = 'g25-38219c8-20260820f') AS incidents", wrangler);
  const oldMv = d1Rows(contract.bridge.oldMaterializedViewDatabaseId,
    "SELECT (SELECT COUNT(*) FROM mv_rows WHERE service_id = 'g25-38219c8-20260820f') AS rows, (SELECT COUNT(*) FROM mv_wait_receipts WHERE service_id = 'g25-38219c8-20260820f') AS receipts", wrangler);
  const newPipelineSchema = d1Rows(contract.final.pipelineDatabase.id,
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY name", wrangler);
  const newMvSchema = d1Rows(contract.final.materializedViewDatabase.id,
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY name", wrangler);
  const resources = resourceListing(wrangler);
  return {
    task: "SDT-G32",
    phase: "pre-final-c",
    capturedAt: new Date().toISOString(),
    dataPreservation: "not-applicable-full-wipe",
    oldStoreInventory: {
      pipeline: { events: numberAt(oldPipeline, "events"), pendingArrivals: numberAt(oldPipeline, "pending"), deliveryIncidents: numberAt(oldPipeline, "incidents") },
      materializedViews: { rows: numberAt(oldMv, "rows"), receipts: numberAt(oldMv, "receipts") },
    },
    newStoreBeforeMigration: {
      pipelineSchema: newPipelineSchema,
      materializedViewSchema: newMvSchema,
      pipelineSchemaDigest: digest(newPipelineSchema),
      materializedViewSchemaDigest: digest(newMvSchema),
    },
    otherServiceWitness: {
      beforeDigest: digest(resources),
      resources,
      excludedCutoverResources: [
        contract.bridge.oldPipelineDatabaseId,
        contract.bridge.oldMaterializedViewDatabaseId,
        contract.bridge.oldQueue,
        contract.final.pipelineDatabase.id,
        contract.final.materializedViewDatabase.id,
        contract.final.queue,
        contract.final.deadLetterQueue,
      ],
    },
  };
}

export function assertG32Config(body, contract, component, sourceCommit, configDigest) {
  const expected = contract.final;
  if (
    body?.task !== "SDT-G32" || body?.phase !== expected.phase || body?.sourceCommit !== sourceCommit ||
    body?.component !== component || body?.configDigest !== configDigest || body?.serviceId !== expected.serviceId ||
    body?.pipelineDatabaseId !== expected.pipelineDatabase.id || body?.materializedViewDatabaseId !== expected.materializedViewDatabase.id ||
    body?.queue !== expected.queue || body?.freezeRelease !== expected.freezeRelease ||
    body?.sortableUniqueId?.digits !== 30 || body?.sortableUniqueId?.legacyUnsupported !== true ||
    body?.eventRecord?.eventType !== "eventPayloadName" || body?.eventRecord?.id !== "uuid-v7" || body?.rawV1PublicStatus !== 404 ||
    typeof body?.cutoverFenceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(body.cutoverFenceFingerprint)
  ) throw new Error(`G32 ${component} remote configuration does not match final C`);
  return Object.freeze({ component, sourceCommit: body.sourceCommit, configDigest: body.configDigest });
}

export async function capturePostWitness({ contract, wrangler, baseUrl, receiverBaseUrl, token, sourceCommit, configDigest, retry }) {
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const [primary, receiver] = await Promise.all([
    retryConformance(() => requestJson(baseUrl, `/conformance/v1/g32-config?g32_witness=${crypto.randomUUID()}`, auth), retry),
    retryConformance(() => requestJson(receiverBaseUrl, `/conformance/v1/g32-config?g32_witness=${crypto.randomUUID()}`, auth), retry),
  ]);
  const [store, raw, bridge] = await Promise.all([
    requestJson(baseUrl, `/conformance/v1/g32-store-state?g32_witness=${crypto.randomUUID()}`, auth),
    requestJson(baseUrl, `/api/sekiban/serialized?g32_witness=${crypto.randomUUID()}`),
    requestJson(baseUrl, `/conformance/v1/g32-bridge?g32_witness=${crypto.randomUUID()}`, auth),
  ]);
  if (primary.status !== 200 || receiver.status !== 200 || store.status !== 200 || raw.status !== 404 || bridge.status !== 404) {
    throw new Error(`G32 post witness endpoint status failure: primary=${primary.status} receiver=${receiver.status} store=${store.status} raw=${raw.status} bridge=${bridge.status}`);
  }
  const primaryAck = assertG32Config(primary.body, contract, "primary", sourceCommit, configDigest);
  const receiverAck = assertG32Config(receiver.body, contract, "receiver", sourceCommit, configDigest);
  if (primary.body.cutoverFenceFingerprint !== receiver.body.cutoverFenceFingerprint) {
    throw new Error("G32 primary/receiver cutover fence fingerprints differ");
  }
  if (
    store.body?.task !== "SDT-G32" || store.body?.serviceId !== contract.final.serviceId ||
    store.body?.legacySerializedEventTablePresent !== false ||
    Number(store.body?.eventCount) !== 0 || Number(store.body?.eventOpsCount) !== 0
  ) throw new Error("G32 post witness new store is not an empty legacy-free baseline");
  const resources = resourceListing(wrangler);
  return {
    task: "SDT-G32",
    phase: "post-final-c-before-writes",
    capturedAt: new Date().toISOString(),
    primary: primary.body,
    receiver: receiver.body,
    componentAcks: [primaryAck, receiverAck],
    newStoreState: store.body,
    rawV1: { status: raw.status, body: raw.body },
    staleBridgeRoute: { status: bridge.status, body: bridge.body },
    otherServiceWitness: { afterDigest: digest(resources), resources },
  };
}

export function assertWitnessTransition(pre, post, contract, sourceCommit) {
  if (pre?.dataPreservation !== "not-applicable-full-wipe") throw new Error("G32 wipe evidence must explicitly mark data preservation not applicable");
  if (!Array.isArray(pre?.newStoreBeforeMigration?.pipelineSchema) || pre.newStoreBeforeMigration.pipelineSchema.some((entry) => entry?.name === "dcb_events")) {
    throw new Error("G32 new pipeline D1 was not empty before migration");
  }
  if (post?.primary?.sourceCommit !== sourceCommit || post?.receiver?.sourceCommit !== sourceCommit) throw new Error("G32 deployed source commit does not equal final C");
  if (post?.primary?.serviceId !== contract.final.serviceId || post?.receiver?.serviceId !== contract.final.serviceId) throw new Error("G32 final service identity mismatch");
  if (post?.rawV1?.status !== 404 || post?.staleBridgeRoute?.status !== 404 || post?.newStoreState?.legacySerializedEventTablePresent !== false) throw new Error("G32 post-cutover legacy closure failed");
  const before = pre.otherServiceWitness?.resources;
  const after = post.otherServiceWitness?.resources;
  if (before === undefined || after === undefined) throw new Error("G32 other-service witness is missing");
  const excluded = new Set(pre.otherServiceWitness.excludedCutoverResources ?? []);
  const filterD1 = (rows) => rows.filter((row) => !excluded.has(row?.uuid)).map((row) => ({ uuid: row.uuid, name: row.name })).sort((a, b) => a.uuid.localeCompare(b.uuid));
  if (JSON.stringify(filterD1(before.d1 ?? [])) !== JSON.stringify(filterD1(after.d1 ?? []))) throw new Error("G32 other-service D1 witness changed");
  const filterQueues = (text) => String(text ?? "").split(/\r?\n/)
    .filter((line) => ![...excluded].some((id) => line.includes(String(id))))
    .filter((line) => !line.includes(contract.final.queue) && !line.includes(contract.final.deadLetterQueue));
  if (JSON.stringify(filterQueues(before.queues)) !== JSON.stringify(filterQueues(after.queues))) throw new Error("G32 other-service Queue witness changed");
  return { dataPreservation: "not-applicable-full-wipe", otherServicesUnchanged: true, sourceCommitMatch: true };
}

function positiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function main() {
  const mode = argument("--mode", "post");
  const contract = expectedContract();
  const output = argument("--output", mode === "pre" ? ".artifacts/g32-pre-witness.json" : ".artifacts/g32-post-witness.json");
  const wrangler = argument("--wrangler", process.env.WRANGLER_BIN ?? "./node_modules/.bin/wrangler");
  if (mode === "pre") {
    const witness = capturePreWitness(contract, wrangler);
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: witness.phase, oldEvents: witness.oldStoreInventory.pipeline.events }, null, 2));
    return;
  }
  if (mode === "compare") {
    const pre = readJson(required("--before", argument("--before")));
    const post = readJson(required("--after", argument("--after")));
    const sourceCommit = required("--source-commit", argument("--source-commit"));
    console.log(JSON.stringify(assertWitnessTransition(pre, post, contract, sourceCommit), null, 2));
    return;
  }
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G32_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) throw new Error("G32 conformance token is empty");
  const witness = await capturePostWitness({
    contract,
    wrangler,
    baseUrl: required("--base-url", argument("--base-url", process.env.G32_BASE_URL)),
    receiverBaseUrl: required("--receiver-base-url", argument("--receiver-base-url", process.env.G32_RECEIVER_BASE_URL)),
    token,
    sourceCommit: required("--source-commit", argument("--source-commit", process.env.G32_SOURCE_COMMIT)),
    configDigest: required("--config-digest", argument("--config-digest", process.env.G32_CONFIG_DIGEST)),
    retry: {
      attempts: positiveInteger("--conformance-retry-attempts", argument("--conformance-retry-attempts", "1"), 1),
      delayMs: nonNegativeInteger("--conformance-retry-delay-ms", argument("--conformance-retry-delay-ms", "0"), 0),
    },
  });
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase: witness.phase, sourceCommit: witness.primary.sourceCommit, eventCount: witness.newStoreState.eventCount }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

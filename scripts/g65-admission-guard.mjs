#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const tagPath = "packages/dcb-runtime/src/tag/TagDurableObject.ts";
const commitPath = "packages/dcb-runtime/src/commit/CommitWorker.ts";
const storePath = "packages/dcb-runtime/src/store/D1EventStore.ts";
const testPath = "test/g65-admission.spec.ts";
const sampleConfigPath = "samples/meeting-room/wrangler.cloudflare-only.jsonc";
const mutationRunnerPath = "scripts/g65-admission-mutation-runner.mjs";
const budgetMs = 300;

function fail(message) {
  throw new Error(`SDT-G65 admission check failed: ${message}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}

function replaceAllRequired(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count < 1) fail(`${label} anchor was not found`);
  return source.replaceAll(from, to);
}

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) fail(`${label} anchor expected once, found ${count}`);
  return source.replace(from, to);
}

function sourceWiring(tagSource, commitSource, storeSource, testSource) {
  const missing = [];
  const append = between(tagSource, "private async append(", "private async directDeliveryBeforeResponse(");
  const direct = between(tagSource, "private async directDeliveryBeforeResponse(", "private async globalAdmissionBeforeResponse(");
  const admission = between(tagSource, "private async globalAdmissionBeforeResponse(", "private async boundedDerivedWrite(");
  const bounded = between(tagSource, "private async boundedDerivedWrite", "private startAutoDrainBeforeResponse(");

  if (!tagSource.includes(`G65_DERIVED_WRITE_BUDGET_MS = ${budgetMs}`)) missing.push("documented derived-write budget");
  if (!tagSource.includes("G65_SOURCE_REGISTRATION_BUDGET_MS = 1_500") &&
    !tagSource.includes("G65_SOURCE_REGISTRATION_BUDGET_MS = 1500")) {
    missing.push("documented source-registration budget");
  }
  if (!tagSource.includes("G65_GLOBAL_ADMISSION_HEADER") || !tagSource.includes("response.headers.set(G65_GLOBAL_ADMISSION_HEADER")) {
    missing.push("internal global-admission status header");
  }
  if (append.length === 0) missing.push("Tag append source");
  if (direct.length === 0) missing.push("direct delivery stage");
  if (admission.length === 0) missing.push("global admission stage");
  if (bounded.length === 0) missing.push("bounded derived write");

  const directCalls = [...append.matchAll(/await this\.directDeliveryBeforeResponse\(/g)];
  const admissionCalls = [...append.matchAll(/await this\.globalAdmissionBeforeResponse\(/g)];
  if (directCalls.length !== 2) missing.push(`two direct attempts (found ${directCalls.length})`);
  if (admissionCalls.length !== 2) missing.push(`two synchronous admission attempts (found ${admissionCalls.length})`);
  if (!append.includes("const result = await this.appendSql(")) missing.push("durable append before derived work");
  if (!tagSource.includes("ensureSourcePartitionBeforeFirstAppend")) missing.push("first-append source registration gate");
  if (!tagSource.includes("sourcePartitionRegistrationStatus")) missing.push("source-registration status lookup");
  if (!tagSource.includes("new PartitionRegistrationUnavailableError")) missing.push("typed first-registration failure");
  if (!tagSource.includes('error(503, "partition_registration_unavailable"') || !tagSource.includes("true)")) {
    missing.push("retryable partition-registration response");
  }
  if (!tagSource.includes("G65_SOURCE_REGISTRATION_MAX_ATTEMPTS = 3") ||
    !tagSource.includes("retrySourcePartitionRegistration") ||
    !tagSource.includes("G65_SOURCE_REGISTRATION_BUDGET_MS") ||
    !tagSource.includes("this.registerSourcePartition(tag, serviceId)")) {
    missing.push("bounded source registry recovery retry");
  }
  if (!tagSource.includes("ensureSourcePartitionBeforeFirstAppend") ||
    !tagSource.includes("registerSourcePartition(tag, serviceId, 0)") ||
    !tagSource.includes("G65_SOURCE_REGISTRATION_BUDGET_MS")) {
    missing.push("first-append registration uses its budget");
  }
  if (!tagSource.includes("if (this.env.D1 === undefined) return \"unconfigured\";") ||
    !tagSource.includes("if (!attempt.value) return \"unconfigured\";")) {
    missing.push("unconfigured completeness path");
  }
  const registrationIndex = append.indexOf("ensureSourcePartitionBeforeFirstAppend(");
  const appendSqlIndex = append.indexOf("this.appendSql(");
  if (!(registrationIndex >= 0 && registrationIndex < appendSqlIndex)) missing.push("registration before durable append");
  if (append.includes("await this.registerSourcePartition(tag, serviceId)")) missing.push("unbounded direct source registry dependency");
  if (!append.includes("const response = json(result.body, result.status);")) missing.push("durable response construction");
  if (!append.includes("return response;")) missing.push("response returned after derived attempts");
  if (!append.includes("this.startAutoDrainBeforeResponse(tag, serviceId, domainDeliveryClass, directRows)")) {
    missing.push("Queue fallback after derived attempts");
  }
  if (!append.includes("this.scheduleSourcePartitionWatermark(tag, serviceId)")) {
    missing.push("post-append source watermark");
  }

  if (!direct.includes("this.boundedDerivedWrite") || !direct.includes("this.deliverDirectRows(rows)")) missing.push("direct doorbell is bounded");
  if (!direct.includes("return rows") || !direct.includes("attempt.status === \"timeout\"")) missing.push("direct timeout preserves Queue rows");
  if (!admission.includes("this.boundedDerivedWrite") || !admission.includes("new D1EventStore(this.env.D1)")) missing.push("global admission uses bounded D1");
  if (!admission.includes("store.recordDelivery(row, Date.now(), \"fast\")")) missing.push("global admission uses shared delivery recording");
  if (!admission.includes("return \"unknown\"")) missing.push("D1 timeout is reported unknown");
  if (!bounded.includes("Promise.race") || !bounded.includes("setTimeout") || !bounded.includes("clearTimeout")) missing.push("derived write budget");
  if (!commitSource.includes("GLOBAL_ADMISSION_HEADER") || !commitSource.includes("mergeGlobalAdmission")) missing.push("CommitWorker admission propagation");
  if (!storeSource.includes("INSERT INTO serialized_dcb_source_partitions") ||
    !storeSource.includes("requiresGlobalReceipt ? 1 : 0") ||
    !storeSource.includes("ON CONFLICT (service_id, partition_tag) DO UPDATE")) {
    missing.push("atomic source-partition admission");
  }
  if (!read(mutationRunnerPath).includes("idempotence-removal")) missing.push("runtime idempotence-removal oracle");
  for (const token of [
    "tag_source_partition_registration",
    "markSourcePartitionRegistration",
    "sourceRegistrationDue",
    "requestedSequence",
    "if (database === undefined) return false",
    "if (!(await this.hasG44GlobalArrayAuthority()))",
    "Promise<boolean>",
  ]) {
    if (!tagSource.includes(token)) missing.push(`source-registration retry: ${token}`);
  }
  for (const token of [
    "new D1EventStore(database())",
    "direct-first",
    "queue-first",
    "D1IdentityConflictError",
    "serialized_dcb_source_partitions",
    "runtime.env.D1 = undefined",
    "state.storage.sql",
    "partition_registration_unavailable",
    "keeps the pre-G65 first-append path when the completeness binding is unavailable",
    "keeps the pre-G65 first-append path when D1 has no configured G44 store",
    "refuses a first append when source-partition registration hangs",
    "commits a registered tag with D1 unavailable and reports not-admitted",
    "does not await registration again for an already-registered tag",
    "expect(rows).toEqual({ events: 1, receipts: 1 })",
    "x-sdt-global-admission",
    "expect(failedRest).toEqual(admittedRest)",
  ]) {
    if (!testSource.includes(token)) missing.push(`runtime oracle: ${token}`);
  }

  const responseIndex = append.indexOf("const response = json(result.body, result.status);");
  const directIndex = append.indexOf("await this.directDeliveryBeforeResponse(");
  const admissionIndex = append.indexOf("await this.globalAdmissionBeforeResponse(");
  const queueIndex = append.indexOf("this.startAutoDrainBeforeResponse(");
  if (!(responseIndex >= 0 && responseIndex < directIndex && directIndex < admissionIndex && admissionIndex < queueIndex)) {
    missing.push("durable append -> direct -> admission -> Queue ordering");
  }
  return { ok: missing.length === 0, missing };
}

function sampleConfiguration() {
  let config;
  try {
    config = JSON.parse(read(sampleConfigPath));
  } catch (error) {
    fail(`current sample configuration is not valid JSON: ${String(error)}`);
  }
  const bindings = new Set((config.d1_databases ?? []).map((entry) => entry?.binding));
  if (!bindings.has("D1") || !bindings.has("D1_MV")) fail("current sample must expose both D1 bindings");
  const queueProducer = (config.queues?.producers ?? []).some((entry) => entry?.binding === "DOWNSTREAM_QUEUE");
  if (!queueProducer) fail("current sample must retain its Queue producer binding");
  return { path: sampleConfigPath, d1Bindings: ["D1", "D1_MV"], queueProducer: "DOWNSTREAM_QUEUE" };
}

function assertRed(label, operation) {
  try {
    operation();
  } catch (error) {
    return { label, result: "red", reason: String(error instanceof Error ? error.message : error) };
  }
  fail(`${label} unexpectedly passed`);
}

function sourceMutantResults(tagSource, commitSource, storeSource, testSource) {
  const check = (tag, store = storeSource) => {
    const wiring = sourceWiring(tag, commitSource, store, testSource);
    if (!wiring.ok) throw new Error(wiring.missing.join(", "));
  };
  const omittedAdmission = replaceAllRequired(tagSource, "await this.globalAdmissionBeforeResponse(tag, serviceId, directRows)", "undefined", "omit-synchronous-admission");
  const directStart = tagSource.indexOf("private async directDeliveryBeforeResponse(");
  const directEnd = tagSource.indexOf("private async globalAdmissionBeforeResponse(", directStart);
  if (directStart < 0 || directEnd < 0) fail("direct delivery section is missing");
  const direct = tagSource.slice(directStart, directEnd);
  const unboundedDirect = `${tagSource.slice(0, directStart)}${replaceOnce(direct, "this.boundedDerivedWrite", "this.unboundedDerivedWrite", "unbounded-doorbell")}${tagSource.slice(directEnd)}`;
  const responseGated = replaceAllRequired(tagSource, "const response = json(result.body, result.status);", "const response = await this.globalAdmissionBeforeResponse(tag, serviceId);", "response-gated-on-D1");
  const durabilityReordered = replaceOnce(tagSource, "const result = await this.appendSql(", "const result = await this.globalAdmissionBeforeResponse(", "durability-before-attempt");
  const omittedDirect = replaceAllRequired(tagSource, "await this.directDeliveryBeforeResponse(tag, serviceId)", "undefined", "omit-direct-attempt");
  const cases = [
    ["omit-synchronous-admission", omittedAdmission],
    ["unbounded-doorbell", unboundedDirect],
    ["response-gated-on-D1", responseGated],
    ["durability-before-attempt", durabilityReordered],
    ["omit-direct-attempt", omittedDirect],
  ];
  const rows = cases.map(([label, mutant]) => assertRed(label, () => check(mutant)));
  rows.push({ label: "idempotence-removal", result: "delegated", oracle: mutationRunnerPath });
  return rows;
}

function main() {
  const tagSource = read(tagPath);
  const commitSource = read(commitPath);
  const storeSource = read(storePath);
  const testSource = read(testPath);
  const wiring = sourceWiring(tagSource, commitSource, storeSource, testSource);
  if (!wiring.ok) fail(wiring.missing.join(", "));
  const configuration = sampleConfiguration();
  const mutants = sourceMutantResults(tagSource, commitSource, storeSource, testSource);
  process.stdout.write(`${JSON.stringify({ check: "g65-admission", configuration, baseline: "pass", mutants, mode: process.argv.includes("--self-test") ? "self-test" : "run" })}\n`);
}

main();

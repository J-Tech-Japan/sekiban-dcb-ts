#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tagPath = "packages/dcb-runtime/src/tag/TagDurableObject.ts";
const commitPath = "packages/dcb-runtime/src/commit/CommitWorker.ts";
const storePath = "packages/dcb-runtime/src/store/D1EventStore.ts";
const testPath = "test/g65-admission.spec.ts";
const budgetMs = 300;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function writeReceipt(relativePath, receipt) {
  if (relativePath === undefined) return;
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

function currentRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function sourceAtHead(relativePath) {
  try {
    return execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: root, encoding: "utf8" });
  } catch {
    return "";
  }
}

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}

function sourceWiring(tagSource, commitSource, storeSource, testSource) {
  const missing = [];
  const append = between(tagSource, "private async append(", "private async directDeliveryBeforeResponse(");
  const direct = between(tagSource, "private async directDeliveryBeforeResponse(", "private async globalAdmissionBeforeResponse(");
  const admission = between(tagSource, "private async globalAdmissionBeforeResponse(", "private async boundedDerivedWrite(");
  const bounded = between(tagSource, "private async boundedDerivedWrite", "private startAutoDrainBeforeResponse(");

  if (!tagSource.includes(`G65_DERIVED_WRITE_BUDGET_MS = ${budgetMs}`)) missing.push("documented 300 ms derived-write budget");
  if (!tagSource.includes("G65_GLOBAL_ADMISSION_HEADER") || !tagSource.includes("response.headers.set(G65_GLOBAL_ADMISSION_HEADER")) {
    missing.push("internal global-admission status header");
  }
  if (append.length === 0) missing.push("Tag append source");
  if (direct.length === 0) missing.push("directDeliveryBeforeResponse");
  if (admission.length === 0) missing.push("globalAdmissionBeforeResponse");
  if (bounded.length === 0) missing.push("boundedDerivedWrite");

  const directCalls = [...append.matchAll(/await this\.directDeliveryBeforeResponse\(/g)];
  const admissionCalls = [...append.matchAll(/await this\.globalAdmissionBeforeResponse\(/g)];
  if (directCalls.length !== 2) missing.push(`two direct attempts (found ${directCalls.length})`);
  if (admissionCalls.length !== 2) missing.push(`two synchronous admission attempts (found ${admissionCalls.length})`);
  if (!append.includes("const result = await this.appendSql(tag, input, serviceId);")) missing.push("durable SQLite append before derived work");
  if (append.includes("await this.registerSourcePartition(tag, serviceId)")) missing.push("synchronous source registry dependency");
  if (!append.includes("const response = json(result.body, result.status);")) missing.push("durable response construction");
  if (!append.includes("return response;")) missing.push("response returned after derived attempts");
  if (!append.includes("this.startAutoDrainBeforeResponse(tag, serviceId, domainDeliveryClass, directRows)")) {
    missing.push("Queue fallback retained after derived attempts");
  }

  if (!direct.includes("this.boundedDerivedWrite") || !direct.includes("this.deliverDirectRows(rows)")) {
    missing.push("direct doorbell is bounded");
  }
  if (!direct.includes("return rows") || !direct.includes("attempt.status === \"timeout\"")) {
    missing.push("direct timeout preserves Queue fallback rows");
  }
  if (!admission.includes("this.boundedDerivedWrite") || !admission.includes("new D1EventStore(this.env.D1)")) {
    missing.push("global admission uses bounded D1EventStore");
  }
  if (!admission.includes("store.recordDelivery(row, Date.now(), \"fast\")")) {
    missing.push("global admission uses the shared recordDelivery path");
  }
  if (!admission.includes("return \"unknown\"")) missing.push("D1 timeout is reported unknown");
  if (!bounded.includes("Promise.race") || !bounded.includes("setTimeout") || !bounded.includes("clearTimeout")) {
    missing.push("derived write Promise.race budget");
  }
  if (!commitSource.includes("GLOBAL_ADMISSION_HEADER") || !commitSource.includes("mergeGlobalAdmission")) {
    missing.push("CommitWorker propagates admission state");
  }
  if (!storeSource.includes("INSERT INTO serialized_dcb_source_partitions") ||
    !storeSource.includes("requiresGlobalReceipt ? 1 : 0") ||
    !storeSource.includes("ON CONFLICT (service_id, partition_tag) DO UPDATE")) {
    missing.push("atomic source-partition admission");
  }
  for (const token of [
    "new D1EventStore(database())",
    "direct-first",
    "queue-first",
    "D1IdentityConflictError",
    "serialized_dcb_source_partitions",
    "runtime.env.D1 = undefined",
    "state.storage.sql",
    "x-sdt-global-admission",
    "not.toHaveProperty(\"globalAdmission\")",
  ]) {
    if (!testSource.includes(token)) missing.push(`real G65 oracle: ${token}`);
  }

  const responseIndex = append.indexOf("const response = json(result.body, result.status);");
  const directIndex = append.indexOf("await this.directDeliveryBeforeResponse(");
  const admissionIndex = append.indexOf("await this.globalAdmissionBeforeResponse(");
  const queueIndex = append.indexOf("this.startAutoDrainBeforeResponse(");
  if (!(responseIndex >= 0 && responseIndex < directIndex && directIndex < admissionIndex && admissionIndex < queueIndex)) {
    missing.push("durable append -> direct -> synchronous admission -> Queue ordering");
  }

  return { ok: missing.length === 0, missing };
}

function assertRed(label, operation) {
  try {
    operation();
  } catch (error) {
    return {
      label,
      status: "red",
      expectedFailure: true,
      reason: String(error instanceof Error ? error.message : error),
    };
  }
  throw new Error(`${label} unexpectedly passed`);
}

function sourceMutantReceipts(tagSource, commitSource, storeSource, testSource) {
  const check = (tag, store = storeSource) => {
    const wiring = sourceWiring(tag, commitSource, store, testSource);
    if (wiring.ok) throw new Error("mutant was not detected");
    throw new Error(`detected: ${wiring.missing.join(", ")}`);
  };
  const mutants = {};
  mutants.omittedAdmission = assertRed("synchronous admission omission mutant", () => {
    const mutant = tagSource.replaceAll("await this.globalAdmissionBeforeResponse(tag, serviceId, directRows)", "undefined");
    check(mutant);
  });
  mutants.unboundedDoorbell = assertRed("unbounded doorbell mutant", () => {
    const directStart = tagSource.indexOf("private async directDeliveryBeforeResponse(");
    const directEnd = tagSource.indexOf("private async globalAdmissionBeforeResponse(", directStart);
    const direct = tagSource.slice(directStart, directEnd).replace("this.boundedDerivedWrite", "this.unboundedDerivedWrite");
    const mutant = `${tagSource.slice(0, directStart)}${direct}${tagSource.slice(directEnd)}`;
    check(mutant);
  });
  mutants.responseGatedOnD1 = assertRed("response-gated-on-D1 mutant", () => {
    check(tagSource.replaceAll("const response = json(result.body, result.status);", "const response = await this.globalAdmissionBeforeResponse(tag, serviceId);"));
  });
  mutants.durabilityReordered = assertRed("durability-before-attempt mutant", () => {
    check(tagSource.replace("const result = await this.appendSql(tag, input, serviceId);", "const result = await this.globalAdmissionBeforeResponse(tag, serviceId);"));
  });
  mutants.duplicateAdmission = assertRed("double-admission mutant", () => {
    check(tagSource, storeSource.replace("ON CONFLICT (service_id, partition_tag) DO UPDATE", "ON CONFLICT (service_id, partition_tag) DO NOTHING"));
  });
  mutants.omittedDirect = assertRed("direct attempt omission mutant", () => {
    check(tagSource.replaceAll("await this.directDeliveryBeforeResponse(tag, serviceId)", "undefined"));
  });
  return mutants;
}

const receiptFile = argument("--receipt");
const preChange = process.argv.includes("--pre-change");
const selfTest = process.argv.includes("--self-test");

if (preChange) {
  const tagSource = sourceAtHead(tagPath);
  const commitSource = sourceAtHead(commitPath);
  const storeSource = sourceAtHead(storePath);
  const testSource = sourceAtHead(testPath);
  const wiring = sourceWiring(tagSource, commitSource, storeSource, testSource);
  const red = assertRed("pre-G65 source", () => {
    if (!wiring.ok) throw new Error(`G65 bounded two-lane admission is absent: ${wiring.missing.join(", ")}`);
    throw new Error("pre-G65 source unexpectedly satisfies the G65 contract");
  });
  const receipt = {
    guard: "SDT-G65 bounded two-lane admission",
    phase: "pre-change",
    status: "red",
    expectedFailure: true,
    sourceRevision: currentRevision(),
    sourcePaths: [tagPath, commitPath, storePath, testPath],
    red,
  };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const tagSource = read(tagPath);
  const commitSource = read(commitPath);
  const storeSource = read(storePath);
  const testSource = read(testPath);
  const wiring = sourceWiring(tagSource, commitSource, storeSource, testSource);
  if (!wiring.ok) {
    const receipt = {
      guard: "SDT-G65 bounded two-lane admission",
      phase: selfTest ? "self-test" : "post-change",
      status: "red",
      expectedFailure: false,
      sourceRevision: currentRevision(),
      wiring,
    };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  } else {
    const green = {
      status: "green",
      oracle: "real D1EventStore, real SQLite-backed Tag append, and public header tests",
    };
    const redMutants = sourceMutantReceipts(tagSource, commitSource, storeSource, testSource);
    const receipt = {
      guard: "SDT-G65 bounded two-lane admission",
      phase: selfTest ? "self-test" : "post-change",
      status: "green",
      sourceRevision: currentRevision(),
      budgetMs,
      sourceWiring: wiring,
      redMutants,
      green,
      contract: "Tag event, outbox obligation and local receipt precede bounded direct unsafe delivery and bounded shared D1 admission; the response is never gated indefinitely and Queue remains the durable fallback/global owner.",
    };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}

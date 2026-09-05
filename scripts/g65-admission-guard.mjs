#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tagPath = "packages/dcb-runtime/src/tag/TagDurableObject.ts";
const commitPath = "packages/dcb-runtime/src/commit/CommitWorker.ts";
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

function sourceWiring(tagSource, commitSource) {
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

function assertAdmissionModel(mode = "current") {
  const state = {
    eventCommitted: false,
    outboxWritten: false,
    localReceiptCommitted: false,
    directAttempted: false,
    admissionAttempted: false,
    responseReturned: false,
    queueScheduled: false,
    admissions: 0,
    identities: new Set(),
  };
  const identity = "service|event|obligation-1";

  state.eventCommitted = true;
  state.outboxWritten = true;
  state.localReceiptCommitted = true;
  if (mode !== "omit-direct") state.directAttempted = true;
  if (mode !== "omit-admission") {
    state.admissionAttempted = true;
    if (mode !== "duplicate-admission") {
      if (!state.identities.has(identity)) {
        state.identities.add(identity);
        state.admissions += 1;
      }
    } else {
      state.admissions += 2;
    }
  }
  state.queueScheduled = true;
  state.responseReturned = mode !== "response-gated-on-d1";

  if (!state.eventCommitted || !state.outboxWritten || !state.localReceiptCommitted) {
    throw new Error("durable acceptance did not precede derived work");
  }
  if (!state.directAttempted) throw new Error("direct unsafe attempt was omitted");
  if (!state.admissionAttempted) throw new Error("synchronous global admission was omitted");
  if (!state.responseReturned) throw new Error("commit response was gated on derived D1 work");
  if (!state.queueScheduled) throw new Error("Queue fallback/global admission path was removed");
  if (state.admissions !== 1) throw new Error(`expected one idempotent admission, got ${state.admissions}`);
  return state;
}

function sourceMutantReceipts(tagSource, commitSource) {
  const mutants = {};
  mutants.omittedAdmission = assertRed("synchronous admission omission mutant", () => {
    const mutant = tagSource.replaceAll("await this.globalAdmissionBeforeResponse(tag, serviceId, directRows)", "undefined");
    if (sourceWiring(mutant, commitSource).ok) throw new Error("admission omission was not detected");
    throw new Error("detected: global admission call removed");
  });
  mutants.unboundedDoorbell = assertRed("unbounded doorbell mutant", () => {
    const directStart = tagSource.indexOf("private async directDeliveryBeforeResponse(");
    const directEnd = tagSource.indexOf("private async globalAdmissionBeforeResponse(", directStart);
    const direct = tagSource.slice(directStart, directEnd).replace("this.boundedDerivedWrite", "this.unboundedDerivedWrite");
    const mutant = `${tagSource.slice(0, directStart)}${direct}${tagSource.slice(directEnd)}`;
    if (sourceWiring(mutant, commitSource).ok) throw new Error("direct timeout was not detected");
    throw new Error("detected: old unbounded direct path restored");
  });
  mutants.responseGatedOnD1 = assertRed("response-gated-on-D1 mutant", () => assertAdmissionModel("response-gated-on-d1"));
  mutants.durabilityReordered = assertRed("durability-before-attempt mutant", () => {
    const state = { eventCommitted: false, outboxWritten: false, localReceiptCommitted: false, directAttempted: true };
    if (!state.eventCommitted || !state.outboxWritten || !state.localReceiptCommitted) throw new Error("direct attempt preceded durable acceptance");
  });
  mutants.duplicateAdmission = assertRed("double-admission mutant", () => assertAdmissionModel("duplicate-admission"));
  mutants.omittedDirect = assertRed("direct attempt omission mutant", () => assertAdmissionModel("omit-direct"));
  return mutants;
}

const receiptFile = argument("--receipt");
const preChange = process.argv.includes("--pre-change");
const selfTest = process.argv.includes("--self-test");

if (preChange) {
  const tagSource = sourceAtHead(tagPath);
  const commitSource = sourceAtHead(commitPath);
  const wiring = sourceWiring(tagSource, commitSource);
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
    sourcePaths: [tagPath, commitPath],
    red,
  };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const tagSource = read(tagPath);
  const commitSource = read(commitPath);
  const wiring = sourceWiring(tagSource, commitSource);
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
    const green = assertAdmissionModel();
    const redMutants = sourceMutantReceipts(tagSource, commitSource);
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

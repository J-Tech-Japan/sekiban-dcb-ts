#!/usr/bin/env node
/**
 * Verifies SDT-G42 P1 advisory evidence without accepting a substituted plan,
 * receipt, provider deployment, or verdict.  This is deliberately a
 * reproducibility checker, not a cryptographic seal: Git P fixes the bytes
 * before the first trial and the checker makes every later substitution
 * visible.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  G42_DECISION_OBJECT,
  G42_RECEIPT_SCHEMA,
  canonicalJson,
  deriveG42Result,
} from "./g42-probe-calculator.mjs";
import { buildG42PreRunPlan, preRunPlanDigest } from "./g42-probe-plan.mjs";

const RESULT_SCHEMA = "sdt.g42.journal-first-touch-result/v1";
const RECEIPT_DOCUMENT_SCHEMA = "sdt.g42.journal-first-touch-receipts/v1";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TYPED_RESULTS = new Set(["COMPLETE", "UNKNOWN", "RUN-INVALID"]);

function fail(message) {
  throw new Error(`g42-check:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function fullSha(value, label) {
  const result = string(value, label);
  if (!SHA.test(result)) fail(`${label} must be a full git SHA`);
  return result;
}

function digest(value, label) {
  const result = string(value, label);
  if (!DIGEST.test(result)) fail(`${label} must be lowercase SHA-256 hex`);
  return result;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptWithoutDigest(receipt) {
  const rest = { ...receipt };
  delete rest.receiptDigest;
  return rest;
}

export function receiptDigest(receipt) {
  return sha256(canonicalJson(receiptWithoutDigest(receipt)));
}

function uniqueIds(values, label) {
  const ids = new Set();
  for (const [index, value] of values.entries()) {
    const id = string(value, `${label}[${index}]`);
    if (ids.has(id)) fail(`${label} duplicates ${id}`);
    ids.add(id);
  }
  return ids;
}

function sameIdSet(actual, expected, label) {
  if (actual.size !== expected.size) fail(`${label} count differs: ${actual.size} != ${expected.size}`);
  for (const id of expected) if (!actual.has(id)) fail(`${label} is missing ${id}`);
  for (const id of actual) if (!expected.has(id)) fail(`${label} contains unscheduled ${id}`);
}

function providerIdentity(value, label) {
  const record = object(value, label);
  const fields = ["worker", "versionId", "versionNumber", "baseUrl", "configReadbackDigest"];
  const actual = Object.keys(record).sort();
  if (!same(actual, [...fields].sort())) fail(`${label} has an unexpected provider identity shape`);
  string(record.worker, `${label}.worker`);
  string(record.versionId, `${label}.versionId`);
  if (!Number.isSafeInteger(record.versionNumber) || record.versionNumber < 1) fail(`${label}.versionNumber must be a positive integer`);
  if (typeof record.baseUrl !== "string" || !record.baseUrl.startsWith("https://")) fail(`${label}.baseUrl must be HTTPS`);
  digest(record.configReadbackDigest, `${label}.configReadbackDigest`);
  return record;
}

function plannedTrials(plan) {
  const schedule = object(plan.schedule, "plan.schedule");
  const blocks = array(schedule.blocks, "plan.schedule.blocks");
  const trials = [];
  for (const [blockIndex, rawBlock] of blocks.entries()) {
    const block = object(rawBlock, `plan.schedule.blocks[${blockIndex}]`);
    const blockId = string(block.blockId, `plan.schedule.blocks[${blockIndex}].blockId`);
    for (const [trialIndex, rawTrial] of array(block.trials, `${blockId}.trials`).entries()) {
      const trial = object(rawTrial, `${blockId}.trials[${trialIndex}]`);
      trials.push(Object.freeze({
        ...trial,
        trialId: string(trial.trialId, `${blockId}.trials[${trialIndex}].trialId`),
        blockId,
      }));
    }
  }
  uniqueIds(trials.map((trial) => trial.trialId), "plan schedule trial IDs");
  return Object.freeze(trials);
}

function assertPlan(plan, calculatorPath, options) {
  object(plan, "plan");
  if (plan.schema !== "sdt.g42.pre-run-plan/v1") fail("plan schema is not recognized");
  if (plan.planDigest !== preRunPlanDigest(plan)) fail("planDigest does not reproduce from the plan bytes");
  if (!same(plan.decision, G42_DECISION_OBJECT)) fail("plan decision object is not the sealed AC6 rule");
  fullSha(plan.targetSourceCommit, "plan.targetSourceCommit");
  providerIdentity(plan.providerIdentity, "plan.providerIdentity");
  const calculator = object(plan.calculator, "plan.calculator");
  if (calculator.path !== calculatorPath) fail(`plan calculator path is ${String(calculator.path)}, expected ${calculatorPath}`);
  const currentCalculatorBytes = readFileSync(calculatorPath, "utf8");
  if (calculator.sha256 !== sha256(currentCalculatorBytes)) fail("calculator bytes no longer match the P hash");
  digest(plan.configDigest, "plan.configDigest");
  digest(plan.moduleBundleDigest, "plan.moduleBundleDigest");
  const trials = plannedTrials(plan);
  if (trials.length !== plan.schedule.scheduledTrialCount) fail("plan scheduledTrialCount does not equal the trial identity set");
  if (options.verifyGit) {
    const planPath = string(options.planPath, "plan path");
    const pPlanBytes = execFileSync("git", ["show", `${options.preRunCommit}:${planPath}`], { encoding: "utf8" });
    const pCalculatorBytes = execFileSync("git", ["show", `${options.preRunCommit}:${calculatorPath}`], { encoding: "utf8" });
    if (pPlanBytes !== options.planBytes) fail("current plan differs from the committed P plan bytes");
    if (pCalculatorBytes !== currentCalculatorBytes) fail("current calculator differs from the committed P calculator bytes");
  }
  return trials;
}

function assertCleanup(receipt, trialId) {
  const cleanup = object(receipt.cleanup, `receipt.${trialId}.cleanup`);
  if (cleanup.trialId !== trialId || cleanup.physicalIdentity !== receipt.physicalIdentity) {
    fail(`receipt.${trialId}.cleanup does not retain its scheduled physical identity`);
  }
  if (cleanup.inventoryEmpty !== true) fail(`receipt.${trialId}.cleanup does not prove inventory empty`);
  for (const phase of ["first", "repeat"]) {
    const operation = object(cleanup[phase], `receipt.${trialId}.cleanup.${phase}`);
    if (operation.schema !== "sdt.g42.journal-first-touch/v1" || operation.action !== "cleanup" || operation.status !== 200) {
      fail(`receipt.${trialId}.cleanup.${phase} does not prove successful idempotent cleanup`);
    }
  }
  const closure = object(receipt.closure, `receipt.${trialId}.closure`);
  if (!Array.isArray(closure.inventory) || closure.inventory.length !== 0) fail(`receipt.${trialId}.closure inventory is not empty`);
  if (closure.alarmDueAt !== null || closure.productionJournalPresent !== false) {
    fail(`receipt.${trialId}.closure does not prove alarm/production separation`);
  }
}

function assertReceiptMatchesTrial(receipt, trial, plan, preRunCommit) {
  const trialId = trial.trialId;
  if (receipt.schema !== G42_RECEIPT_SCHEMA) fail(`receipt.${trialId} schema is not recognized`);
  if (!TYPED_RESULTS.has(receipt.status)) fail(`receipt.${trialId} lacks a typed status`);
  if (receipt.blockId !== trial.blockId || receipt.cell !== trial.cell || receipt.physicalIdentity !== trial.physicalIdentity
    || receipt.logicalKey !== trial.logicalKey || (receipt.warmupLogicalKey ?? null) !== (trial.warmupLogicalKey ?? null)) {
    fail(`receipt.${trialId} does not retain the scheduled treatment identity`);
  }
  if (receipt.sourceCommit !== plan.targetSourceCommit) fail(`receipt.${trialId} source commit differs from P target source`);
  if (receipt.preRunCommit !== preRunCommit) fail(`receipt.${trialId} P identity differs from the runner P`);
  if (!same(providerIdentity(receipt.providerIdentity, `receipt.${trialId}.providerIdentity`), plan.providerIdentity)) {
    fail(`receipt.${trialId} provider identity differs from P`);
  }
  if (receipt.receiptDigest !== receiptDigest(receipt)) fail(`receipt.${trialId} receipt digest does not reproduce`);
  assertCleanup(receipt, trialId);
  if (receipt.status === "COMPLETE") object(receipt.trialReceipt, `receipt.${trialId}.trialReceipt`);
}

function receiptsFromDocument(document, plan, preRunCommit) {
  const receiptDocument = object(document, "receipt document");
  if (receiptDocument.schema !== RECEIPT_DOCUMENT_SCHEMA) fail("receipt document schema is not recognized");
  if (receiptDocument.planId !== plan.planId || receiptDocument.planDigest !== plan.planDigest) fail("receipt document does not bind P plan identity");
  if (receiptDocument.preRunCommit !== preRunCommit) fail("receipt document P identity differs from runner P");
  if (receiptDocument.state !== "COMPLETE") fail("receipt document is not a completed schedule run");
  if (!same(providerIdentity(receiptDocument.providerIdentity, "receipt document.providerIdentity"), plan.providerIdentity)) {
    fail("receipt document provider identity differs from P");
  }
  const rows = array(receiptDocument.receipts, "receipt document.receipts");
  const receiptIds = uniqueIds(rows.map((receipt, index) => string(object(receipt, `receipts[${index}]`).trialId, `receipts[${index}].trialId`)), "receipt IDs");
  const trials = plannedTrials(plan);
  const plannedById = new Map(trials.map((trial) => [trial.trialId, trial]));
  sameIdSet(receiptIds, new Set(plannedById.keys()), "receipt IDs against schedule");
  for (const rawReceipt of rows) {
    const receipt = object(rawReceipt, "receipt");
    assertReceiptMatchesTrial(receipt, plannedById.get(receipt.trialId), plan, preRunCommit);
  }
  sameIdSet(
    uniqueIds(rows.map((receipt, index) => string(object(receipt, `receipts[${index}]`).physicalIdentity, `receipts[${index}].physicalIdentity`)), "receipt physical identities"),
    uniqueIds(trials.map((trial) => string(trial.physicalIdentity, `planned.${trial.trialId}.physicalIdentity`)), "planned physical identities"),
    "cleanup physical identities against schedule",
  );
  return rows;
}

function assertResult(result, plan, receipts) {
  const committed = object(result, "result");
  if (committed.schema !== RESULT_SCHEMA) fail("result schema is not recognized");
  const resultIds = uniqueIds(array(committed.trialResults, "result.trialResults").map((row, index) => string(object(row, `result.trialResults[${index}]`).trialId, `result.trialResults[${index}].trialId`)), "result trial IDs");
  const receiptIds = new Set(receipts.map((receipt) => receipt.trialId));
  sameIdSet(resultIds, receiptIds, "result IDs against receipt IDs");
  const recomputed = deriveG42Result(plan, receipts);
  if (!same(committed, recomputed)) fail("committed result or verdict differs from deterministic P recalculation");
  return recomputed;
}

export function assertG42Evidence({
  plan,
  receiptDocument,
  result,
  preRunCommit,
  planPath,
  calculatorPath = "scripts/g42-probe-calculator.mjs",
  planBytes = JSON.stringify(plan, null, 2) + "\n",
  verifyGit = false,
}) {
  const p = fullSha(preRunCommit, "preRunCommit");
  const trials = assertPlan(plan, calculatorPath, { verifyGit, preRunCommit: p, planPath, planBytes });
  const receipts = receiptsFromDocument(receiptDocument, plan, p);
  const derived = assertResult(result, plan, receipts);
  return Object.freeze({
    scheduledTrialCount: trials.length,
    receiptCount: receipts.length,
    verdict: derived.verdict,
    completePrimaryBlocks: derived.primary.completeBlockCount,
  });
}

/** Validates just the immutable P inputs before a runner is allowed to send a trial. */
export function assertG42PreRunPlan({
  plan,
  preRunCommit,
  planPath,
  calculatorPath = "scripts/g42-probe-calculator.mjs",
  planBytes = JSON.stringify(plan, null, 2) + "\n",
  verifyGit = false,
}) {
  const p = fullSha(preRunCommit, "preRunCommit");
  const trials = assertPlan(plan, calculatorPath, { verifyGit, preRunCommit: p, planPath, planBytes });
  return Object.freeze({ planId: plan.planId, planDigest: plan.planDigest, scheduledTrialCount: trials.length, trials });
}

function fixture() {
  const calculatorBytes = readFileSync("scripts/g42-probe-calculator.mjs", "utf8");
  const plan = buildG42PreRunPlan({
    createdAt: "2026-08-27T00:00:00.000Z",
    targetSourceCommit: "a".repeat(40),
    configDigest: "b".repeat(64),
    moduleBundleDigest: "c".repeat(64),
    provider: {
      worker: "fixture-worker",
      versionId: "fixture-version",
      versionNumber: 1,
      baseUrl: "https://fixture.example",
      configReadbackDigest: "d".repeat(64),
    },
    calculatorBytes,
  });
  const preRunCommit = "e".repeat(40);
  const receipts = plannedTrials(plan).map((trial) => {
    const receipt = {
      schema: G42_RECEIPT_SCHEMA,
      trialId: trial.trialId,
      blockId: trial.blockId,
      cell: trial.cell,
      physicalIdentity: trial.physicalIdentity,
      logicalKey: trial.logicalKey,
      ...(trial.warmupLogicalKey === undefined ? {} : { warmupLogicalKey: trial.warmupLogicalKey }),
      status: "COMPLETE",
      sourceCommit: plan.targetSourceCommit,
      preRunCommit,
      providerIdentity: plan.providerIdentity,
      trialReceipt: {
        callerWallMs: trial.cell === "A" ? 400 : trial.cell === "D" ? 200 : 300,
        callerColo: "SJC",
        measured: {
          logicalKey: trial.logicalKey,
          setAlarmCalls: trial.alarmMode === "on" ? 1 : 0,
          alarmStateBefore: null,
          alarmDueAt: trial.alarmMode === "on" ? 123 : null,
          handlerWallMs: trial.cell === "A" ? 250 : trial.cell === "D" ? 125 : 175,
          transactionWallMs: trial.cell === "A" ? 100 : trial.cell === "D" ? 50 : 75,
          activation: { activationId: `fixture-${trial.blockId}`, activationFirst: trial.cell === "A" },
          ...(trial.cell === "D" ? { expectedWarmupKeyPresent: true } : {}),
        },
        ...(trial.cell === "A" ? {} : {
          preceding: trial.cell === "B"
            ? { action: "ping", status: 200, activation: { activationId: `fixture-${trial.blockId}` } }
            : trial.cell === "C"
              ? { action: "state", status: 404, keyPresent: false, activation: { activationId: `fixture-${trial.blockId}` } }
              : { action: "write", status: 200, logicalKey: trial.warmupLogicalKey, activation: { activationId: `fixture-${trial.blockId}` } },
        }),
        treatmentCompliance: {
          measuredActivationFirst: trial.cell === "A",
          sharedActivationId: trial.cell === "A" ? null : true,
          mediatorCompletedBeforeMeasurement: trial.cell === "C" ? true : null,
          distinctLogicalKey: trial.cell === "D" ? true : null,
          alarmStateEqualized: true,
          alarmSetExactlyOnce: true,
        },
      },
      cleanup: {
        trialId: trial.trialId,
        physicalIdentity: trial.physicalIdentity,
        inventoryEmpty: true,
        first: { schema: "sdt.g42.journal-first-touch/v1", action: "cleanup", status: 200 },
        repeat: { schema: "sdt.g42.journal-first-touch/v1", action: "cleanup", status: 200 },
      },
      closure: { inventory: [], alarmDueAt: null, productionJournalPresent: false },
    };
    return { ...receipt, receiptDigest: receiptDigest(receipt) };
  });
  const receiptDocument = {
    schema: RECEIPT_DOCUMENT_SCHEMA,
    planId: plan.planId,
    planDigest: plan.planDigest,
    preRunCommit,
    providerIdentity: plan.providerIdentity,
    state: "COMPLETE",
    receipts,
  };
  return { plan, preRunCommit, receiptDocument, result: deriveG42Result(plan, receipts) };
}

function expectedRed(name, mutate) {
  const original = fixture();
  const changed = structuredClone(original);
  mutate(changed);
  try {
    assertG42Evidence({ ...changed });
  } catch (error) {
    return { name, exitStatus: 1, message: error instanceof Error ? error.message : String(error) };
  }
  fail(`self-test mutation ${name} unexpectedly passed`);
}

export function selfTest() {
  const baseline = fixture();
  const accepted = assertG42Evidence(baseline);
  const failures = [
    expectedRed("post-P-schedule-change", (entry) => { entry.plan.schedule.blocks[0].trials[0].cell = "D"; }),
    expectedRed("post-P-decision-change", (entry) => { entry.plan.decision.bootstrap.seed = 7; }),
    expectedRed("post-P-calculator-change", (entry) => { entry.plan.calculator.sha256 = "0".repeat(64); }),
    expectedRed("identity-missing", (entry) => { entry.receiptDocument.receipts.pop(); }),
    expectedRed("identity-extra", (entry) => {
      const extra = structuredClone(entry.receiptDocument.receipts[0]);
      extra.trialId = "g42-p1-extra-identity";
      entry.receiptDocument.receipts.push(extra);
    }),
    expectedRed("identity-duplicate", (entry) => { entry.receiptDocument.receipts.push(structuredClone(entry.receiptDocument.receipts[0])); }),
    expectedRed("identity-replacement", (entry) => { entry.receiptDocument.receipts[0].trialId = "g42-p1-primary-replaced-a"; }),
    expectedRed("receipt-source-mismatch", (entry) => { entry.receiptDocument.receipts[0].sourceCommit = "f".repeat(40); }),
    expectedRed("receipt-P-mismatch", (entry) => { entry.receiptDocument.receipts[0].preRunCommit = "f".repeat(40); }),
    expectedRed("receipt-provider-mismatch", (entry) => {
      entry.receiptDocument.receipts[0].providerIdentity = {
        ...entry.receiptDocument.receipts[0].providerIdentity,
        versionId: "wrong",
      };
    }),
    expectedRed("committed-verdict-mismatch", (entry) => { entry.result.verdict = "NOT_SUPPORTED_AS_NEXT_LEVER"; }),
  ];
  return Object.freeze({ accepted, forcedRed: failures });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const planPath = string(argument("--plan"), "--plan");
  const receiptPath = string(argument("--receipts"), "--receipts");
  const resultPath = string(argument("--result"), "--result");
  const preRunCommit = fullSha(argument("--pre-run-commit"), "--pre-run-commit");
  const planBytes = readFileSync(planPath, "utf8");
  const outcome = assertG42Evidence({
    plan: JSON.parse(planBytes),
    receiptDocument: JSON.parse(readFileSync(receiptPath, "utf8")),
    result: JSON.parse(readFileSync(resultPath, "utf8")),
    preRunCommit,
    planPath,
    planBytes,
    verifyGit: true,
  });
  console.log(JSON.stringify(outcome, null, 2));
}
if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) main();

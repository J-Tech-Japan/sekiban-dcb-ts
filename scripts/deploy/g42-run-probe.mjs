#!/usr/bin/env node
/**
 * Executes exactly the pre-committed G42 P1 schedule.  It intentionally
 * never retries a trial: an ambiguous/non-200 request is retained as UNKNOWN,
 * cleanup is still attempted, and its scheduled identity is never replaced.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { G42_JOURNAL_PROBE_PATH, G42_JOURNAL_PROBE_SCHEMA } from "../../packages/dcb-runtime/dist/g42-probe.js";
import { deriveG42Result } from "../g42-probe-calculator.mjs";
import { assertG42PreRunPlan, receiptDigest } from "../g42-probe-check.mjs";

const RECEIPT_DOCUMENT_SCHEMA = "sdt.g42.journal-first-touch-receipts/v1";
const SHA = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(`g42-runner:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function fullSha(name, value) {
  const result = required(name, value);
  if (!SHA.test(result)) fail(`${name} must be a full git SHA`);
  return result;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function sleep(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, milliseconds)));
}

function trackedTreeMustBeClean(preRunCommit) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== preRunCommit) fail(`HEAD ${head} differs from committed P ${preRunCommit}`);
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (dirty.length !== 0) fail("tracked tree is not clean at P");
}

function canonicalBaseUrl(value) {
  const baseUrl = new URL(required("--base-url", value));
  if (baseUrl.protocol !== "https:") fail("--base-url must be HTTPS");
  baseUrl.pathname = baseUrl.pathname.replace(/\/$/, "");
  baseUrl.search = "";
  baseUrl.hash = "";
  return baseUrl.toString().replace(/\/$/, "");
}

function externalRequestBody(trial, action = "trial") {
  return {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action,
    trialId: trial.trialId,
    blockId: trial.blockId,
    cell: trial.cell,
    physicalIdentity: trial.physicalIdentity,
    logicalKey: trial.logicalKey,
    warmupLogicalKey: trial.warmupLogicalKey,
    payload: "p".repeat(trial.payloadBytes),
    alarmMode: trial.alarmMode,
    mediator: trial.mediator,
  };
}

function cleanupBody(trial) {
  return {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "cleanup",
    trialId: trial.trialId,
    physicalIdentity: trial.physicalIdentity,
  };
}

function inventoryBody(trial) {
  return {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "inventory",
    trialId: trial.trialId,
    physicalIdentity: trial.physicalIdentity,
  };
}

async function post(baseUrl, token, body) {
  const serialized = JSON.stringify(body);
  const startedAtMs = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}${G42_JOURNAL_PROBE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: serialized,
      cache: "no-store",
    });
  } catch (error) {
    return Object.freeze({
      transport: "failed",
      startedAtMs,
      completedAtMs: Date.now(),
      requestBytes: Buffer.byteLength(serialized),
      reason: error instanceof Error ? error.name : "transport_error",
    });
  }
  const completedAtMs = Date.now();
  let parsed;
  try {
    parsed = object(JSON.parse(await response.text()));
  } catch {
    parsed = undefined;
  }
  return Object.freeze({
    transport: "received",
    startedAtMs,
    completedAtMs,
    requestBytes: Buffer.byteLength(serialized),
    status: response.status,
    cfRay: response.headers.get("cf-ray"),
    body: parsed,
  });
}

function validTrialReceipt(value, trial) {
  const receipt = object(value);
  if (receipt?.schema !== G42_JOURNAL_PROBE_SCHEMA || receipt.trialId !== trial.trialId || receipt.cell !== trial.cell) return undefined;
  const compliance = object(receipt.treatmentCompliance);
  const measured = object(receipt.measured);
  if (compliance === undefined || measured === undefined || typeof receipt.callerWallMs !== "number" || !Number.isFinite(receipt.callerWallMs)) return undefined;
  return receipt;
}

function validPreparationReceipt(value, trial) {
  const receipt = object(value);
  const preparation = object(receipt?.preparation);
  if (receipt?.schema !== G42_JOURNAL_PROBE_SCHEMA || receipt.trialId !== trial.trialId || receipt.cell !== "D"
    || receipt.physicalIdentity !== trial.physicalIdentity || receipt.logicalKey !== trial.logicalKey
    || receipt.warmupLogicalKey !== trial.warmupLogicalKey || preparation === undefined) return undefined;
  return receipt;
}

function validMeasurementReceipt(value, trial) {
  const receipt = object(value);
  const measured = object(receipt?.measured);
  const compliance = object(receipt?.treatmentCompliance);
  if (receipt?.schema !== G42_JOURNAL_PROBE_SCHEMA || receipt.trialId !== trial.trialId || receipt.cell !== "D"
    || receipt.physicalIdentity !== trial.physicalIdentity || receipt.logicalKey !== trial.logicalKey
    || receipt.warmupLogicalKey !== trial.warmupLogicalKey || measured === undefined || compliance === undefined
    || typeof receipt.callerWallMs !== "number" || !Number.isFinite(receipt.callerWallMs)) return undefined;
  return receipt;
}

function mergeIdleDReceipts(trial, preparation, measurement) {
  const preceding = object(preparation.preparation);
  const measured = object(measurement.measured);
  const compliance = object(measurement.treatmentCompliance);
  const precedingActivation = object(preceding?.activation);
  const measuredActivation = object(measured?.activation);
  if (preceding === undefined || measured === undefined || compliance === undefined || precedingActivation === undefined || measuredActivation === undefined) {
    return undefined;
  }
  const sharedActivationId = typeof precedingActivation.activationId === "string"
    && precedingActivation.activationId === measuredActivation.activationId;
  const distinctLogicalKey = preceding.logicalKey === trial.warmupLogicalKey
    && measured.logicalKey === trial.logicalKey
    && preceding.logicalKey !== measured.logicalKey
    && measured.expectedWarmupKeyPresent === true;
  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: trial.trialId,
    blockId: trial.blockId,
    cell: "D",
    physicalIdentity: trial.physicalIdentity,
    logicalKey: trial.logicalKey,
    warmupLogicalKey: trial.warmupLogicalKey,
    callerWallMs: measurement.callerWallMs,
    callerColo: measurement.callerColo ?? null,
    measured,
    preceding,
    treatmentCompliance: Object.freeze({
      measuredActivationFirst: compliance.measuredActivationFirst,
      sharedActivationId,
      mediatorCompletedBeforeMeasurement: null,
      distinctLogicalKey,
      alarmStateEqualized: compliance.alarmStateEqualized,
      alarmSetExactlyOnce: compliance.alarmSetExactlyOnce,
    }),
  });
}

function idleActivationClassification(trial, receipt) {
  if (trial.cell !== "D" || trial.requestedIdleMs === 0 || receipt === undefined) return undefined;
  const compliance = object(receipt.treatmentCompliance);
  if (compliance === undefined) return "UNKNOWN";
  if (compliance.measuredActivationFirst === false && compliance.sharedActivationId === true) return "CONTINUITY";
  if (compliance.measuredActivationFirst === true && compliance.sharedActivationId === false) return "RESTART";
  return "UNKNOWN";
}

function treatmentReason(trial, receipt) {
  const compliance = object(receipt.treatmentCompliance);
  const measured = object(receipt.measured);
  if (compliance === undefined || measured === undefined) return "malformed-trial-receipt";
  if (trial.cell === "A" && compliance.measuredActivationFirst !== true) return "A-activation-first-violation";
  // Idle D is explicitly a sensitivity experiment: a measured restart is a
  // result stratum, not a protocol violation. Immediate B/C/D still require
  // a shared, non-first activation as their treatment-compliance fact.
  const idleD = trial.cell === "D" && trial.requestedIdleMs > 0;
  if (!idleD && trial.cell !== "A" && (compliance.measuredActivationFirst !== false || compliance.sharedActivationId !== true)) {
    return "shared-activation-violation";
  }
  if (idleD && idleActivationClassification(trial, receipt) === "UNKNOWN") return "idle-D-activation-classification-unknown";
  if (trial.cell === "C" && compliance.mediatorCompletedBeforeMeasurement !== true) return "C-mediator-violation";
  if (trial.cell === "D" && compliance.distinctLogicalKey !== true) return "D-distinct-logical-key-violation";
  if (compliance.alarmStateEqualized !== true || compliance.alarmSetExactlyOnce !== true) return "alarm-prestate-or-installation-violation";
  if (trial.alarmMode === "on" && measured.setAlarmCalls !== 1) return "alarm-on-set-call-violation";
  if (trial.alarmMode === "off" && measured.setAlarmCalls !== 0) return "alarm-off-set-call-violation";
  return undefined;
}

function closureFacts(cleanupResponse, inventoryResponse, trial) {
  const cleanup = object(cleanupResponse?.body);
  const inventoryEnvelope = object(inventoryResponse?.body);
  const inventory = object(inventoryEnvelope?.inventory);
  const cleanupOperation = (phase) => {
    const value = object(cleanup?.[phase]);
    return value?.schema === G42_JOURNAL_PROBE_SCHEMA && value.action === "cleanup" && value.status === 200;
  };
  const cleanupValid = cleanupResponse?.transport === "received" && cleanupResponse.status === 200
    && cleanup?.schema === G42_JOURNAL_PROBE_SCHEMA && cleanup.inventoryEmpty === true
    && cleanup.trialId === trial.trialId && cleanup.physicalIdentity === trial.physicalIdentity
    && cleanupOperation("first") && cleanupOperation("repeat");
  const inventoryValid = inventoryResponse?.transport === "received" && inventoryResponse.status === 200
    && inventoryEnvelope?.schema === G42_JOURNAL_PROBE_SCHEMA
    && inventoryEnvelope.trialId === trial.trialId && inventoryEnvelope.physicalIdentity === trial.physicalIdentity
    && inventory?.schema === G42_JOURNAL_PROBE_SCHEMA && Array.isArray(inventory.inventory)
    && inventory.inventory.length === 0 && inventory.alarmDueAt === null && inventory.productionJournalPresent === false;
  return Object.freeze({
    cleanup: cleanupValid ? cleanup : { inventoryEmpty: false, status: cleanupResponse?.status ?? null },
    closure: inventoryValid
      ? { inventory: [], alarmDueAt: null, productionJournalPresent: false }
      : { inventory: ["closure-unverified"], alarmDueAt: "unverified", productionJournalPresent: true },
    valid: cleanupValid && inventoryValid,
  });
}

function receiptBase(plan, preRunCommit, trial, status, details) {
  const receipt = {
    schema: "sdt.g42.journal-first-touch-receipt/v1",
    trialId: trial.trialId,
    blockId: trial.blockId,
    cell: trial.cell,
    physicalIdentity: trial.physicalIdentity,
    logicalKey: trial.logicalKey,
      warmupLogicalKey: trial.warmupLogicalKey,
    status,
    sourceCommit: plan.targetSourceCommit,
    preRunCommit,
    providerIdentity: plan.providerIdentity,
    requestedIdleMs: trial.requestedIdleMs,
    payloadBytes: trial.payloadBytes,
    recordedAt: new Date().toISOString(),
    ...details,
  };
  return Object.freeze({ ...receipt, receiptDigest: receiptDigest(receipt) });
}

function documentFor(plan, preRunCommit, receipts, state) {
  return {
    schema: RECEIPT_DOCUMENT_SCHEMA,
    planId: plan.planId,
    planDigest: plan.planDigest,
    preRunCommit,
    providerIdentity: plan.providerIdentity,
    state,
    receipts,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function executeTrial(baseUrl, token, trial) {
  const idleD = trial.cell === "D" && trial.requestedIdleMs > 0;
  if (!idleD) {
    let requestedIdleObservedMs = 0;
    if (trial.requestedIdleMs > 0) {
      const idleStartedAtMs = Date.now();
      await sleep(trial.requestedIdleMs);
      requestedIdleObservedMs = Date.now() - idleStartedAtMs;
    }
    const externalTrial = await post(baseUrl, token, externalRequestBody(trial));
    return Object.freeze({
      externalTrial,
      rawTrialReceipt: externalTrial.transport === "received" && externalTrial.status === 200
        ? validTrialReceipt(externalTrial.body, trial)
        : undefined,
      requestedIdleObservedMs,
      ...(trial.requestedIdleMs > 0 ? { idleProtocol: "fresh-A-reference waited before its measured write" } : {}),
    });
  }

  // D's warm-up finishes before the gap.  The later measurement is therefore
  // genuinely classified by the Durable Object's observed activation rather
  // than being labelled warm merely because an idle interval was requested.
  const preparationResponse = await post(baseUrl, token, externalRequestBody(trial, "prepare"));
  const preparation = preparationResponse.transport === "received" && preparationResponse.status === 200
    ? validPreparationReceipt(preparationResponse.body, trial)
    : undefined;
  if (preparation === undefined) {
    return Object.freeze({
      externalTrial: preparationResponse,
      rawTrialReceipt: undefined,
      requestedIdleObservedMs: 0,
      idleProtocol: "D preparation failed before requested idle gap",
      preparationTiming: preparationResponse,
    });
  }
  const idleStartedAtMs = Date.now();
  await sleep(trial.requestedIdleMs);
  const requestedIdleObservedMs = Date.now() - idleStartedAtMs;
  const externalTrial = await post(baseUrl, token, externalRequestBody(trial, "measure"));
  const measurement = externalTrial.transport === "received" && externalTrial.status === 200
    ? validMeasurementReceipt(externalTrial.body, trial)
    : undefined;
  return Object.freeze({
    externalTrial,
    rawTrialReceipt: measurement === undefined ? undefined : mergeIdleDReceipts(trial, preparation, measurement),
    requestedIdleObservedMs,
    idleProtocol: "D warmup completed before requested idle gap; post-gap measurement classified by observed activation",
    preparationTiming: preparationResponse,
  });
}

function markColoInvalidBlocks(plan, receipts) {
  const receiptsById = new Map(receipts.map((receipt) => [receipt.trialId, receipt]));
  const invalidBlockIds = new Map();
  for (const block of plan.schedule.blocks) {
    const blockReceipts = block.trials.map((trial) => receiptsById.get(trial.trialId));
    const colos = blockReceipts.map((receipt) => {
      const trialReceipt = object(receipt?.trialReceipt);
      return typeof trialReceipt?.callerColo === "string" && trialReceipt.callerColo.length > 0
        ? trialReceipt.callerColo
        : undefined;
    });
    if (colos.some((colo) => colo === undefined)) {
      invalidBlockIds.set(block.blockId, "block-caller-colo-unknown");
    } else if (new Set(colos).size !== 1) {
      invalidBlockIds.set(block.blockId, "block-caller-colo-disagrees");
    }
  }
  return receipts.map((receipt) => {
    const reason = invalidBlockIds.get(receipt.blockId);
    if (reason === undefined || receipt.status === "RUN-INVALID") return receipt;
    const next = { ...receipt, status: "UNKNOWN", reason };
    return Object.freeze({ ...next, receiptDigest: receiptDigest(next) });
  });
}

export async function runG42Probe({ baseUrl, token, plan, preRunCommit, planPath, planBytes, receiptOutput, resultOutput }) {
  const verified = assertG42PreRunPlan({ plan, preRunCommit, planPath, planBytes, verifyGit: true });
  if (canonicalBaseUrl(baseUrl) !== canonicalBaseUrl(plan.providerIdentity.baseUrl)) {
    fail("--base-url differs from P providerIdentity.baseUrl");
  }
  if (existsSync(receiptOutput) || existsSync(resultOutput)) fail("refusing to replace an existing P1 receipt or result artifact");
  const receipts = [];
  let priorCompletedAtMs = Date.now();
  for (const trial of verified.trials) {
    const execution = await executeTrial(baseUrl, token, trial);
    const { externalTrial, rawTrialReceipt } = execution;
    const reason = rawTrialReceipt === undefined
      ? externalTrial.transport === "received"
        ? externalTrial.status === 200 ? "malformed-trial-receipt" : `trial-http-${externalTrial.status}`
        : externalTrial.reason
      : treatmentReason(trial, rawTrialReceipt);
    // Cleanup and inventory are intentionally separate requests and timings.
    const cleanupResponse = await post(baseUrl, token, cleanupBody(trial));
    const inventoryResponse = await post(baseUrl, token, inventoryBody(trial));
    const closure = closureFacts(cleanupResponse, inventoryResponse, trial);
    const status = closure.valid ? (reason === undefined ? "COMPLETE" : "UNKNOWN") : "RUN-INVALID";
    const receipt = receiptBase(plan, preRunCommit, trial, status, {
      ...(reason === undefined ? {} : { reason }),
      requestTiming: {
        requestedIdleObservedMs: execution.requestedIdleObservedMs,
        sincePriorTrialCompletedMs: Math.max(0, externalTrial.startedAtMs - priorCompletedAtMs),
        externalRequestBytes: externalTrial.requestBytes,
        startedAtMs: externalTrial.startedAtMs,
        completedAtMs: externalTrial.completedAtMs,
        cfRay: externalTrial.cfRay ?? null,
        httpStatus: externalTrial.status ?? null,
      },
      ...(execution.idleProtocol === undefined ? {} : { idleProtocol: execution.idleProtocol }),
      ...(execution.preparationTiming === undefined ? {} : { preparationTiming: execution.preparationTiming }),
      ...(idleActivationClassification(trial, rawTrialReceipt) === undefined ? {} : {
        observedIdleActivation: idleActivationClassification(trial, rawTrialReceipt),
      }),
      ...(rawTrialReceipt === undefined ? {} : { trialReceipt: rawTrialReceipt }),
      cleanup: closure.cleanup,
      closure: closure.closure,
    });
    receipts.push(receipt);
    priorCompletedAtMs = externalTrial.completedAtMs;
    // A crash leaves a non-replaceable partial ledger rather than erasing an
    // already-issued scheduled identity.
    writeJson(receiptOutput, documentFor(plan, preRunCommit, receipts, "IN_PROGRESS"));
  }
  const finalizedReceipts = markColoInvalidBlocks(plan, receipts);
  const receiptDocument = documentFor(plan, preRunCommit, finalizedReceipts, "COMPLETE");
  writeJson(receiptOutput, receiptDocument);
  const result = deriveG42Result(plan, finalizedReceipts);
  writeJson(resultOutput, result);
  return Object.freeze({
    planId: plan.planId,
    receiptOutput,
    resultOutput,
    scheduledTrialCount: finalizedReceipts.length,
    verdict: result.verdict,
    completePrimaryBlocks: result.primary.completeBlockCount,
  });
}

export function selfTest() {
  const trial = Object.freeze({
    trialId: "g42-p1-idle-47-d",
    blockId: "g42-p1-block-47",
    cell: "D",
    physicalIdentity: "sdt-g42-p1-identity-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    logicalKey: "sdt-g42-p1-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    warmupLogicalKey: "sdt-g42-p1-key-cccccccccccccccccccccccccccccccc",
    requestedIdleMs: 180_000,
    payloadBytes: 512,
    alarmMode: "on",
    mediator: "none",
  });
  const operation = (logicalKey, activationId, activationFirst, expectedWarmupKeyPresent = undefined) => Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "write",
    status: 200,
    logicalKey,
    ...(expectedWarmupKeyPresent === undefined ? {} : { expectedWarmupKeyPresent }),
    activation: { activationId, activationFirst, constructorToHandlerMs: 1, firstStorageReadMs: 0 },
    handlerWallMs: 1,
    transactionWallMs: 1,
    requestBytes: 10,
    recordBytes: 10,
    alarmStateBefore: null,
    alarmDueAt: Date.now() + 60_000,
    setAlarmCalls: 1,
  });
  const preparation = {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: trial.trialId,
    blockId: trial.blockId,
    cell: "D",
    physicalIdentity: trial.physicalIdentity,
    logicalKey: trial.logicalKey,
    warmupLogicalKey: trial.warmupLogicalKey,
    preparation: operation(trial.warmupLogicalKey, "activation-1", true),
  };
  const measurement = {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: trial.trialId,
    blockId: trial.blockId,
    cell: "D",
    physicalIdentity: trial.physicalIdentity,
    logicalKey: trial.logicalKey,
    warmupLogicalKey: trial.warmupLogicalKey,
    callerWallMs: 5,
    callerColo: "SJC",
    measured: operation(trial.logicalKey, "activation-2", true, true),
    treatmentCompliance: { measuredActivationFirst: true, alarmStateEqualized: true, alarmSetExactlyOnce: true },
  };
  const merged = mergeIdleDReceipts(trial, preparation, measurement);
  if (merged === undefined || idleActivationClassification(trial, merged) !== "RESTART") {
    fail("post-idle restart did not remain a measured sensitivity stratum");
  }
  const callerReceipt = (trialId, blockId, colo) => ({
    trialId,
    blockId,
    status: "COMPLETE",
    trialReceipt: { callerColo: colo },
  });
  const aTrial = { ...trial, trialId: "g42-p1-idle-47-a", cell: "A" };
  const colos = markColoInvalidBlocks({ schedule: { blocks: [{ blockId: trial.blockId, trials: [aTrial, trial] }] } }, [
    callerReceipt(aTrial.trialId, trial.blockId, "SJC"),
    callerReceipt(trial.trialId, trial.blockId, "LAX"),
  ]);
  if (!colos.every((receipt) => receipt.status === "UNKNOWN" && receipt.reason === "block-caller-colo-disagrees")) {
    fail("caller-colo mismatch did not invalidate the whole balanced block");
  }
  return Object.freeze({ idleRestart: "RESTART", blockColoMismatch: "all-unknown" });
}

async function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const planPath = required("--plan", argument("--plan"));
  const planBytes = readFileSync(planPath, "utf8");
  const plan = JSON.parse(planBytes);
  const preRunCommit = fullSha("--pre-run-commit", argument("--pre-run-commit"));
  trackedTreeMustBeClean(preRunCommit);
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G42_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) fail("conformance token file is empty");
  const receiptOutput = argument("--receipts", ".artifacts/SDT-G42-raw-receipts.json");
  const resultOutput = argument("--result", ".artifacts/SDT-G42-derived-result.json");
  const outcome = await runG42Probe({
    baseUrl: required("--base-url", argument("--base-url", process.env.G42_BASE_URL)),
    token,
    plan,
    preRunCommit,
    planPath,
    planBytes,
    receiptOutput,
    resultOutput,
  });
  console.log(JSON.stringify(outcome, null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

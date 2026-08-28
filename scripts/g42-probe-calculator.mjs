#!/usr/bin/env node
/**
 * Deterministic SDT-G42 advisory decision calculator.
 *
 * The calculator deliberately consumes only the committed P1 schedule and
 * raw receipts.  It has no network access, does not choose a next lever, and
 * cannot turn an UNKNOWN trial into a completed observation.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const G42_RESULT_SCHEMA = "sdt.g42.journal-first-touch-result/v1";
export const G42_RECEIPT_SCHEMA = "sdt.g42.journal-first-touch-receipt/v1";

export const G42_DECISION_OBJECT = Object.freeze({
  schema: "sdt.g42.decision/v1",
  primaryRegime: Object.freeze({
    requestedIdleMs: 0,
    payloadProfile: "real-512",
    alarmMode: "on",
    contrast: "A-minus-D-caller-wall-ms",
  }),
  samplingUnit: "whole-balanced-block",
  bootstrap: Object.freeze({
    family: "percentile",
    replicates: 1024,
    prng: "mulberry32",
    seed: 4_242_421,
    median: "even-average; odd-middle; ties-retained",
    quantile: "nearest-rank-ceil",
    rounding: "nearest-0.1-ms-half-up",
  }),
  completeBlockFloor: 30,
  scheduledPrimaryBlocks: 40,
  actionabilityThresholdMs: 160,
  boundaries: Object.freeze({
    lowerEqual160: "INCONCLUSIVE",
    upperEqual160: "NOT_SUPPORTED_AS_NEXT_LEVER",
    fewerThan30CompleteBlocks: "INCONCLUSIVE",
  }),
  verdicts: Object.freeze([
    "SUPPORTS_C1_PACKETIZATION",
    "NOT_SUPPORTED_AS_NEXT_LEVER",
    "INCONCLUSIVE",
  ]),
});

function fail(message) {
  throw new Error(`g42-calculator:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function roundTenth(value) {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function pairedMedian(values) {
  if (!Array.isArray(values) || values.length === 0) fail("paired median needs at least one value");
  const ordered = values.map((value, index) => finite(value, `difference[${index}]`)).sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function nearestRank(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) fail("quantile needs at least one value");
  if (typeof fraction !== "number" || fraction <= 0 || fraction >= 1) fail("quantile fraction must be in (0,1)");
  const ordered = values.map((value, index) => finite(value, `quantile[${index}]`)).sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function wholeBlockBootstrap(differences, decision = G42_DECISION_OBJECT) {
  if (!Array.isArray(differences) || differences.length === 0) fail("bootstrap needs complete block differences");
  const rng = mulberry32(decision.bootstrap.seed);
  const replicates = [];
  for (let replicate = 0; replicate < decision.bootstrap.replicates; replicate += 1) {
    const sampled = Array.from({ length: differences.length }, () => differences[Math.floor(rng() * differences.length)]);
    replicates.push(pairedMedian(sampled));
  }
  return Object.freeze({
    replicates: decision.bootstrap.replicates,
    lower: roundTenth(nearestRank(replicates, 0.025)),
    upper: roundTenth(nearestRank(replicates, 0.975)),
  });
}

/** AC6's boundary ordering is explicit so `lower === 160` cannot drift. */
export function advisoryVerdict(completeBlockCount, interval, decision = G42_DECISION_OBJECT) {
  if (completeBlockCount < decision.completeBlockFloor || interval === null) return "INCONCLUSIVE";
  if (interval.lower > decision.actionabilityThresholdMs) return "SUPPORTS_C1_PACKETIZATION";
  if (interval.upper <= decision.actionabilityThresholdMs) return "NOT_SUPPORTED_AS_NEXT_LEVER";
  return "INCONCLUSIVE";
}

function cellReceipt(receiptsById, trial) {
  const receipt = receiptsById.get(trial.trialId);
  if (receipt === undefined || receipt.status !== "COMPLETE") return undefined;
  const actual = object(receipt.trialReceipt, `receipt.${trial.trialId}.trialReceipt`);
  const compliance = object(actual.treatmentCompliance, `receipt.${trial.trialId}.treatmentCompliance`);
  const measured = object(actual.measured, `receipt.${trial.trialId}.measured`);
  const measuredActivation = object(measured.activation, `receipt.${trial.trialId}.measured.activation`);
  const callerWallMs = finite(actual.callerWallMs, `receipt.${trial.trialId}.callerWallMs`);
  const handlerWallMs = finite(measured.handlerWallMs, `receipt.${trial.trialId}.measured.handlerWallMs`);
  const transactionWallMs = measured.transactionWallMs === null
    ? null
    : finite(measured.transactionWallMs, `receipt.${trial.trialId}.measured.transactionWallMs`);
  const callerColo = typeof actual.callerColo === "string" && actual.callerColo.length > 0 ? actual.callerColo : undefined;
  const expectedFirst = trial.cell === "A";
  const preceding = actual.preceding === undefined ? undefined : object(actual.preceding, `receipt.${trial.trialId}.preceding`);
  const activationId = nonEmpty(measuredActivation.activationId, `receipt.${trial.trialId}.measured.activation.activationId`);
  const measuredActivationFirst = measuredActivation.activationFirst === expectedFirst && compliance.measuredActivationFirst === expectedFirst;
  const sharedActivationId = expectedFirst
    ? preceding === undefined
    : preceding !== undefined
      && object(preceding.activation, `receipt.${trial.trialId}.preceding.activation`).activationId === activationId
      && compliance.sharedActivationId === true;
  const mediator = trial.cell === "B"
    ? preceding?.action === "ping" && preceding.status >= 200 && preceding.status < 300
    : trial.cell === "C"
      ? preceding?.action === "state" && preceding.status === 404 && preceding.keyPresent === false && compliance.mediatorCompletedBeforeMeasurement === true
      : true;
  const distinctLogicalKey = trial.cell === "D"
    ? preceding?.action === "write" && preceding.status === 200 && preceding.logicalKey === trial.warmupLogicalKey
      && measured.logicalKey === trial.logicalKey && measured.expectedWarmupKeyPresent === true && compliance.distinctLogicalKey === true
    : true;
  const alarm = compliance.alarmStateEqualized === true && compliance.alarmSetExactlyOnce === true && measured.alarmStateBefore === null;
  if (!measuredActivationFirst || !sharedActivationId || !mediator || !distinctLogicalKey || !alarm) return undefined;
  if (trial.alarmMode === "on" && (measured.setAlarmCalls !== 1 || typeof measured.alarmDueAt !== "number")) return undefined;
  if (trial.alarmMode === "off" && (measured.setAlarmCalls !== 0 || measured.alarmDueAt !== null)) return undefined;
  return Object.freeze({ callerWallMs, handlerWallMs, transactionWallMs, callerColo });
}

function primaryBlocks(plan) {
  const schedule = object(plan.schedule, "plan.schedule");
  if (!Array.isArray(schedule.blocks)) fail("plan.schedule.blocks must be an array");
  return schedule.blocks.filter((block) => {
    const factor = object(block?.factor, "plan.schedule.blocks[].factor");
    return factor.requestedIdleMs === G42_DECISION_OBJECT.primaryRegime.requestedIdleMs
      && factor.payloadProfile === G42_DECISION_OBJECT.primaryRegime.payloadProfile
      && factor.alarmMode === G42_DECISION_OBJECT.primaryRegime.alarmMode
      && factor.role === "primary";
  });
}

function completePrimaryBlock(receiptsById, block) {
  const trials = Array.isArray(block.trials) ? block.trials : [];
  const byCell = new Map(trials.map((trial) => [trial?.cell, trial]));
  if (byCell.size !== 4 || !["A", "B", "C", "D"].every((cell) => byCell.has(cell))) return undefined;
  const cells = Object.fromEntries(["A", "B", "C", "D"].map((cell) => [cell, cellReceipt(receiptsById, byCell.get(cell))]));
  if (Object.values(cells).some((entry) => entry === undefined)) return undefined;
  const colos = new Set(Object.values(cells).map((entry) => entry.callerColo));
  if (colos.size !== 1 || colos.has(undefined)) return undefined;
  return Object.freeze({
    blockId: nonEmpty(block.blockId, "block.blockId"),
    callerColo: cells.A.callerColo,
    differenceMs: roundTenth(cells.A.callerWallMs - cells.D.callerWallMs),
    A: cells.A.callerWallMs,
    D: cells.D.callerWallMs,
    explanatory: Object.freeze({
      handlerDifferenceMs: roundTenth(cells.A.handlerWallMs - cells.D.handlerWallMs),
      ...(cells.A.transactionWallMs === null || cells.D.transactionWallMs === null
        ? {}
        : { transactionDifferenceMs: roundTenth(cells.A.transactionWallMs - cells.D.transactionWallMs) }),
      callerMinusHandlerDifferenceMs: roundTenth(
        (cells.A.callerWallMs - cells.A.handlerWallMs) - (cells.D.callerWallMs - cells.D.handlerWallMs),
      ),
    }),
  });
}

function descriptiveDifference(blocks, field) {
  const values = blocks
    .map((block) => block.explanatory[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return Object.freeze({
    count: values.length,
    ...(values.length === 0 ? { pairedMedianMs: null } : { pairedMedianMs: roundTenth(pairedMedian(values)) }),
  });
}

function idleActivation(receipt) {
  const actual = object(receipt.trialReceipt, `receipt.${receipt.trialId}.trialReceipt`);
  const compliance = object(actual.treatmentCompliance, `receipt.${receipt.trialId}.treatmentCompliance`);
  if (compliance.measuredActivationFirst === false && compliance.sharedActivationId === true) return "CONTINUITY";
  if (compliance.measuredActivationFirst === true && compliance.sharedActivationId === false) return "RESTART";
  return "UNKNOWN";
}

function aDCellForSensitivity(receiptsById, trial) {
  const receipt = receiptsById.get(trial.trialId);
  if (receipt === undefined || receipt.status !== "COMPLETE") return undefined;
  if (trial.cell === "A") return cellReceipt(receiptsById, trial);
  const actual = object(receipt.trialReceipt, `receipt.${trial.trialId}.trialReceipt`);
  const compliance = object(actual.treatmentCompliance, `receipt.${trial.trialId}.treatmentCompliance`);
  const measured = object(actual.measured, `receipt.${trial.trialId}.measured`);
  const callerWallMs = finite(actual.callerWallMs, `receipt.${trial.trialId}.callerWallMs`);
  const callerColo = typeof actual.callerColo === "string" && actual.callerColo.length > 0 ? actual.callerColo : undefined;
  const alarm = compliance.alarmStateEqualized === true && compliance.alarmSetExactlyOnce === true;
  if (!alarm || (trial.alarmMode === "on" && measured.setAlarmCalls !== 1) || (trial.alarmMode === "off" && measured.setAlarmCalls !== 0)) return undefined;
  if (trial.requestedIdleMs === 0) {
    if (compliance.measuredActivationFirst !== false || compliance.sharedActivationId !== true || compliance.distinctLogicalKey !== true) return undefined;
    return Object.freeze({ callerWallMs, callerColo, observedActivation: "CONTINUITY" });
  }
  if (compliance.distinctLogicalKey !== true) return undefined;
  const observedActivation = idleActivation(receipt);
  if (observedActivation === "UNKNOWN") return undefined;
  return Object.freeze({ callerWallMs, callerColo, observedActivation });
}

function descriptiveMedian(values) {
  return values.length === 0 ? null : roundTenth(pairedMedian(values));
}

function sensitivityReports(plan, receiptsById) {
  const blocks = array(object(plan.schedule, "plan.schedule").blocks, "plan.schedule.blocks")
    .filter((block) => object(block.factor, "sensitivity.factor").role !== "primary");
  const groups = new Map();
  for (const block of blocks) {
    const factor = object(block.factor, "sensitivity.factor");
    const trials = array(block.trials, "sensitivity.trials");
    const a = trials.find((trial) => trial?.cell === "A");
    const d = trials.find((trial) => trial?.cell === "D");
    const group = groups.get(factor.role) ?? { factor, rows: [] };
    groups.set(factor.role, group);
    if (a === undefined || d === undefined) {
      group.rows.push(Object.freeze({ blockId: block.blockId, status: "UNKNOWN", reason: "A-or-D-missing-from-schedule" }));
      continue;
    }
    const aCell = aDCellForSensitivity(receiptsById, a);
    const dCell = aDCellForSensitivity(receiptsById, d);
    if (aCell === undefined || dCell === undefined || aCell.callerColo === undefined || dCell.callerColo === undefined || aCell.callerColo !== dCell.callerColo) {
      group.rows.push(Object.freeze({ blockId: block.blockId, status: "UNKNOWN", reason: "incomplete-or-caller-colo-mismatch" }));
      continue;
    }
    group.rows.push(Object.freeze({
      blockId: block.blockId,
      status: "COMPLETE",
      callerColo: aCell.callerColo,
      differenceMs: roundTenth(aCell.callerWallMs - dCell.callerWallMs),
      observedDActivation: dCell.observedActivation,
    }));
  }
  return Object.freeze([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => {
    const completed = group.rows.filter((row) => row.status === "COMPLETE");
    const activationCounts = Object.freeze({
      continuity: completed.filter((row) => row.observedDActivation === "CONTINUITY").length,
      restart: completed.filter((row) => row.observedDActivation === "RESTART").length,
      unknown: group.rows.length - completed.length,
    });
    return Object.freeze({
      factor: group.factor,
      scheduledBlockCount: group.rows.length,
      completeBlockCount: completed.length,
      unknownBlockCount: group.rows.length - completed.length,
      pairedMedianCallerWallMs: descriptiveMedian(completed.map((row) => row.differenceMs)),
      observedDActivation: activationCounts,
      decisionEligibleUnderAC6: completed.length >= G42_DECISION_OBJECT.completeBlockFloor,
      scope: group.factor.requestedIdleMs > 0
        ? "Sensitivity-only idle report; requested gap is stratified by observed D activation continuity/restart."
        : "Factor-cross descriptive screen; it does not replace the primary AC6 A-versus-D decision.",
      blocks: Object.freeze(group.rows),
    });
  }));
}

function normalizedReceiptRows(receipts) {
  if (!Array.isArray(receipts)) fail("receipts must be an array");
  return receipts.map((receipt, index) => {
    const value = object(receipt, `receipts[${index}]`);
    nonEmpty(value.trialId, `receipts[${index}].trialId`);
    if (!["COMPLETE", "UNKNOWN", "RUN-INVALID"].includes(value.status)) {
      fail(`receipts[${index}].status is not a typed result`);
    }
    return value;
  });
}

export function deriveG42Result(plan, receipts) {
  object(plan, "plan");
  if (!equalJson(plan.decision, G42_DECISION_OBJECT)) fail("plan decision object differs from the sealed calculator rule");
  const normalizedReceipts = normalizedReceiptRows(receipts);
  const receiptsById = new Map(normalizedReceipts.map((receipt) => [receipt.trialId, receipt]));
  if (receiptsById.size !== normalizedReceipts.length) fail("receipt trial identities are duplicated");
  const blocks = primaryBlocks(plan);
  if (blocks.length !== G42_DECISION_OBJECT.scheduledPrimaryBlocks) {
    fail(`plan has ${blocks.length} primary blocks; expected ${G42_DECISION_OBJECT.scheduledPrimaryBlocks}`);
  }
  const complete = blocks.map((block) => completePrimaryBlock(receiptsById, block)).filter((block) => block !== undefined);
  const differences = complete.map((block) => block.differenceMs);
  const interval = complete.length < G42_DECISION_OBJECT.completeBlockFloor
    ? null
    : wholeBlockBootstrap(differences);
  const median = complete.length === 0 ? null : roundTenth(pairedMedian(differences));
  const verdict = advisoryVerdict(complete.length, interval);
  const scheduledTrialIds = plan.schedule.blocks.flatMap((block) => block.trials.map((trial) => trial.trialId));
  return Object.freeze({
    schema: G42_RESULT_SCHEMA,
    planId: plan.planId,
    targetSourceCommit: plan.targetSourceCommit,
    providerIdentity: plan.providerIdentity,
    decision: G42_DECISION_OBJECT,
    trialResults: Object.freeze(normalizedReceipts.map((receipt) => Object.freeze({
      trialId: receipt.trialId,
      status: receipt.status,
      ...(typeof receipt.reason === "string" ? { reason: receipt.reason } : {}),
    }))),
    primary: Object.freeze({
      scheduledBlockCount: blocks.length,
      completeBlockCount: complete.length,
      unknownBlockCount: blocks.length - complete.length,
      pairedMedianCallerWallMs: median,
      ...(interval === null ? {} : { interval }),
      completeBlocks: Object.freeze(complete),
      explanatoryOnly: Object.freeze({
        scope: "Descriptive whole-block A-minus-D differences. They explain the caller-wall contrast and never select the AC6 verdict.",
        handlerWall: descriptiveDifference(complete, "handlerDifferenceMs"),
        transactionWall: descriptiveDifference(complete, "transactionDifferenceMs"),
        callerMinusHandler: descriptiveDifference(complete, "callerMinusHandlerDifferenceMs"),
      }),
    }),
    sensitivityReports: sensitivityReports(plan, receiptsById),
    verdict,
    advisory: Object.freeze({
      level: "ADVISORY",
      reuseForC1Acceptance: false,
      nextLeverPredetermined: false,
      scheduledTrialCount: scheduledTrialIds.length,
    }),
  });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const plan = JSON.parse(readFileSync(required("--plan", argument("--plan")), "utf8"));
  const receiptDocument = JSON.parse(readFileSync(required("--receipts", argument("--receipts")), "utf8"));
  const receipts = Array.isArray(receiptDocument) ? receiptDocument : receiptDocument.receipts;
  const output = required("--output", argument("--output"));
  const result = deriveG42Result(plan, receipts);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: result.verdict, completeBlocks: result.primary.completeBlockCount }, null, 2));
}

export function selfTest() {
  const bootstrapFirst = wholeBlockBootstrap(Array.from({ length: 40 }, () => 200));
  const bootstrapSecond = wholeBlockBootstrap(Array.from({ length: 40 }, () => 200));
  if (!equalJson(bootstrapFirst, bootstrapSecond)) fail("fixed-seed bootstrap is not deterministic");
  const boundaries = Object.freeze({
    fewerThan30: advisoryVerdict(29, { lower: 200, upper: 200 }),
    lowerEqual160: advisoryVerdict(30, { lower: 160, upper: 161 }),
    upperEqual160: advisoryVerdict(30, { lower: 159, upper: 160 }),
    support: advisoryVerdict(30, { lower: 160.1, upper: 240 }),
  });
  if (boundaries.fewerThan30 !== "INCONCLUSIVE"
    || boundaries.lowerEqual160 !== "INCONCLUSIVE"
    || boundaries.upperEqual160 !== "NOT_SUPPORTED_AS_NEXT_LEVER"
    || boundaries.support !== "SUPPORTS_C1_PACKETIZATION") {
    fail("AC6 verdict boundary fixture changed");
  }
  if (pairedMedian([1, 3, 7, 9]) !== 5 || nearestRank([1, 3, 7, 9], 0.95) !== 9) {
    fail("median or nearest-rank convention changed");
  }
  return Object.freeze({ bootstrap: bootstrapFirst, boundaries, decision: G42_DECISION_OBJECT });
}

if (import.meta.url === `file://${process.argv[1]}`) main();

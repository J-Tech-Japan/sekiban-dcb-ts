#!/usr/bin/env node
/** Builds the immutable-before-trial SDT-G42 P1 schedule and decision plan. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { G42_DECISION_OBJECT, canonicalJson } from "./g42-probe-calculator.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTITY_PREFIX = "sdt-g42-p1-identity-";
const LOGICAL_KEY_PREFIX = "sdt-g42-p1-key-";
const PLAN_SCHEMA = "sdt.g42.pre-run-plan/v1";

function fail(message) {
  throw new Error(`g42-plan:${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function sha(name, value) {
  const result = required(name, value);
  if (!SHA.test(result)) fail(`${name} must be a full git SHA`);
  return result;
}

function digest(name, value) {
  const result = required(name, value);
  if (!DIGEST.test(result)) fail(`${name} must be sha256 hex without a prefix`);
  return result;
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

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function key(prefix, value) {
  return `${prefix}${sha256(value).slice(0, 32)}`;
}

function trialFor(planId, blockId, cell, factor) {
  const trialId = `g42-p1-${factor.role}-${blockId.slice(-2)}-${cell.toLowerCase()}`;
  const physicalIdentity = key(IDENTITY_PREFIX, `${planId}:${trialId}:physical`);
  const logicalKey = key(LOGICAL_KEY_PREFIX, `${planId}:${trialId}:logical`);
  return Object.freeze({
    trialId,
    cell,
    physicalIdentity,
    logicalKey,
    // The externally timed request carries this fixed-width field for every
    // cell. Only D uses a distinct value; A/B/C repeat logicalKey as inert
    // padding so A/D's caller envelope has equal serialized bytes.
    warmupLogicalKey: cell === "D"
      ? key(LOGICAL_KEY_PREFIX, `${planId}:${trialId}:warmup`)
      : logicalKey,
    alarmMode: factor.alarmMode,
    payloadProfile: factor.payloadProfile,
    payloadBytes: factor.payloadBytes,
    requestedIdleMs: factor.requestedIdleMs,
    mediator: cell === "B" ? "handler-ping" : cell === "C" ? "state-404" : "none",
  });
}

function blockFor(planId, ordinal, factor, cells, random) {
  const blockId = `g42-p1-block-${String(ordinal).padStart(2, "0")}`;
  const orderedCells = shuffled(cells, random);
  return Object.freeze({
    blockId,
    factor: Object.freeze(factor),
    cellOrder: Object.freeze(orderedCells),
    trials: Object.freeze(orderedCells.map((cell) => trialFor(planId, blockId, cell, factor))),
  });
}

function providerIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("provider identity must be an object");
  const record = value;
  if (typeof record.worker !== "string" || record.worker.length === 0) fail("provider.worker is required");
  if (typeof record.versionId !== "string" || record.versionId.length === 0) fail("provider.versionId is required");
  if (!Number.isSafeInteger(record.versionNumber) || record.versionNumber < 1) fail("provider.versionNumber must be a positive integer");
  if (typeof record.baseUrl !== "string" || !/^https:\/\//.test(record.baseUrl)) fail("provider.baseUrl must be HTTPS");
  if (typeof record.configReadbackDigest !== "string" || !DIGEST.test(record.configReadbackDigest)) fail("provider.configReadbackDigest must be sha256 hex");
  return Object.freeze({
    worker: record.worker,
    versionId: record.versionId,
    versionNumber: record.versionNumber,
    baseUrl: record.baseUrl,
    configReadbackDigest: record.configReadbackDigest,
  });
}

function planWithoutDigest(plan) {
  const rest = { ...plan };
  delete rest.planDigest;
  return rest;
}

export function preRunPlanDigest(plan) {
  return sha256(canonicalJson(planWithoutDigest(plan)));
}

export function buildG42PreRunPlan({
  planId = "g42-p1-plan-v1",
  createdAt,
  targetSourceCommit,
  configDigest,
  moduleBundleDigest,
  provider,
  calculatorBytes,
}) {
  if (!/^g42-p1-plan-[a-z0-9-]+$/.test(planId)) fail("planId is not reserved");
  const random = mulberry32(G42_DECISION_OBJECT.bootstrap.seed);
  const blocks = [];
  let ordinal = 1;
  const primaryFactor = Object.freeze({
    role: "primary",
    requestedIdleMs: 0,
    payloadProfile: "real-512",
    payloadBytes: 512,
    alarmMode: "on",
  });
  for (let block = 0; block < G42_DECISION_OBJECT.scheduledPrimaryBlocks; block += 1) {
    blocks.push(blockFor(planId, ordinal, primaryFactor, ["A", "B", "C", "D"], random));
    ordinal += 1;
  }
  for (const factor of [
    { role: "factor-cross-small-on", requestedIdleMs: 0, payloadProfile: "small-128", payloadBytes: 128, alarmMode: "on" },
    { role: "factor-cross-real-off", requestedIdleMs: 0, payloadProfile: "real-512", payloadBytes: 512, alarmMode: "off" },
    { role: "factor-cross-small-off", requestedIdleMs: 0, payloadProfile: "small-128", payloadBytes: 128, alarmMode: "off" },
  ]) {
    for (let replicate = 0; replicate < 2; replicate += 1) {
      blocks.push(blockFor(planId, ordinal, factor, ["A", "D"], random));
      ordinal += 1;
    }
  }
  for (const requestedIdleMs of [2_000, 15_000, 180_000]) {
    for (let replicate = 0; replicate < 2; replicate += 1) {
      blocks.push(blockFor(planId, ordinal, {
        role: `idle-${requestedIdleMs}ms`,
        requestedIdleMs,
        payloadProfile: "real-512",
        payloadBytes: 512,
        alarmMode: "on",
      }, ["A", "D"], random));
      ordinal += 1;
    }
  }
  const plan = {
    schema: PLAN_SCHEMA,
    planId,
    createdAt: required("createdAt", createdAt),
    targetSourceCommit: sha("targetSourceCommit", targetSourceCommit),
    configDigest: digest("configDigest", configDigest),
    moduleBundleDigest: digest("moduleBundleDigest", moduleBundleDigest),
    providerIdentity: providerIdentity(provider),
    calculator: Object.freeze({
      path: "scripts/g42-probe-calculator.mjs",
      sha256: sha256(required("calculatorBytes", calculatorBytes)),
    }),
    decision: G42_DECISION_OBJECT,
    schedule: Object.freeze({
      family: "balanced-randomized-block",
      scheduleSeed: G42_DECISION_OBJECT.bootstrap.seed,
      noReplacement: true,
      primaryContrast: "A-versus-D",
      blocks: Object.freeze(blocks),
      scheduledTrialCount: blocks.reduce((count, block) => count + block.trials.length, 0),
      idleClassification: "observed activation; requested idle is not a warm label",
      idleProtocol: "D prepares its alarm-free warmup record before the requested gap, then measures after it; A is a fresh reference in the same randomized block/window.",
    }),
    advisoryOnly: true,
    note: "P is this committed plan plus its clean Git HEAD supplied to the runner; no cryptographic or adversarial tamper-resistance claim is made.",
  };
  return Object.freeze({ ...plan, planDigest: preRunPlanDigest(plan) });
}

export function selfTest() {
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
    calculatorBytes: "fixture-calculator",
  });
  const trialIds = plan.schedule.blocks.flatMap((block) => block.trials.map((trial) => trial.trialId));
  if (new Set(trialIds).size !== trialIds.length) fail("self-test schedule repeats a trial identity");
  if (plan.schedule.blocks.filter((block) => block.factor.role === "primary").length !== 40) fail("self-test primary block count differs");
  if (!plan.schedule.blocks.some((block) => block.factor.requestedIdleMs === 180_000)) fail("self-test lacks 180s idle regime");
  if (plan.planDigest !== preRunPlanDigest(plan)) fail("self-test plan digest does not reproduce");
  const trials = plan.schedule.blocks.flatMap((block) => block.trials);
  if (trials.some((trial) => trial.cell === "D" ? trial.warmupLogicalKey === trial.logicalKey : trial.warmupLogicalKey !== trial.logicalKey)) {
    fail("self-test does not preserve the A/D fixed-width envelope rule");
  }
  return Object.freeze({
    blockCount: plan.schedule.blocks.length,
    trialCount: trialIds.length,
    primaryBlocks: 40,
    payloadProfiles: ["small-128", "real-512"],
    idleRegimesMs: [2_000, 15_000, 180_000],
  });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const provider = JSON.parse(readFileSync(required("--provider", argument("--provider")), "utf8"));
  const calculatorBytes = readFileSync("scripts/g42-probe-calculator.mjs", "utf8");
  const plan = buildG42PreRunPlan({
    createdAt: argument("--created-at", new Date().toISOString()),
    targetSourceCommit: argument("--target-source-commit"),
    configDigest: argument("--config-digest"),
    moduleBundleDigest: argument("--module-bundle-digest"),
    provider,
    calculatorBytes,
  });
  const output = required("--output", argument("--output"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ planId: plan.planId, planDigest: plan.planDigest, trials: plan.schedule.scheduledTrialCount }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

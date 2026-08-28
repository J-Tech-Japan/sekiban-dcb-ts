#!/usr/bin/env node
/** Creates P only from the code-only deploy's source/build/read-back facts. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildG42PreRunPlan } from "../g42-probe-plan.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`g42-prepare-plan:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
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
  if (!DIGEST.test(result)) fail(`${label} must be SHA-256 hex`);
  return result;
}

function cleanCandidateHead() {
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (dirty.length !== 0) fail("tracked tree must be clean before writing P");
  return fullSha(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "HEAD");
}

export function buildPlanFromDeployFacts({ witness, buildFacts, head, calculatorBytes, createdAt }) {
  const deployment = object(witness, "witness");
  const build = object(buildFacts, "build facts");
  if (deployment.schema !== "sdt.g42.deployment-witness/v1") fail("witness schema is not recognized");
  if (build.schema !== "sdt.g42.build-facts/v1") fail("build facts schema is not recognized");
  const source = fullSha(deployment.sourceCommit, "witness.sourceCommit");
  if (source !== fullSha(build.sourceCommit, "build.sourceCommit") || source !== fullSha(head, "HEAD")) {
    fail("deploy witness, build facts, and clean candidate HEAD must name the same source commit");
  }
  const configDigest = digest(build.configDigest, "build.configDigest");
  if (configDigest !== digest(deployment.configFileDigest, "witness.configFileDigest")) {
    fail("build config digest differs from deployment read-back config digest");
  }
  const provider = object(deployment.providerIdentity, "witness.providerIdentity");
  if (provider.worker !== build.worker || provider.baseUrl !== build.baseUrl) {
    fail("deploy provider identity differs from build facts worker/base URL");
  }
  return buildG42PreRunPlan({
    planId: `g42-p1-plan-${source.slice(0, 12)}`,
    createdAt,
    targetSourceCommit: source,
    configDigest,
    moduleBundleDigest: digest(build.moduleBundleDigest, "build.moduleBundleDigest"),
    provider,
    calculatorBytes,
  });
}

export function selfTest() {
  const source = "a".repeat(40);
  const config = "b".repeat(64);
  const module = "c".repeat(64);
  const providerIdentity = { worker: "fixture", versionId: "version", versionNumber: 1, baseUrl: "https://fixture.example", configReadbackDigest: "d".repeat(64) };
  const witness = { schema: "sdt.g42.deployment-witness/v1", sourceCommit: source, configFileDigest: config, providerIdentity };
  const buildFacts = { schema: "sdt.g42.build-facts/v1", sourceCommit: source, configDigest: config, moduleBundleDigest: module, worker: "fixture", baseUrl: "https://fixture.example" };
  const accepted = buildPlanFromDeployFacts({ witness, buildFacts, head: source, calculatorBytes: "calculator", createdAt: "2026-08-27T00:00:00.000Z" });
  let forcedRed = false;
  try { buildPlanFromDeployFacts({ witness, buildFacts: { ...buildFacts, configDigest: "e".repeat(64) }, head: source, calculatorBytes: "calculator", createdAt: "2026-08-27T00:00:00.000Z" }); } catch { forcedRed = true; }
  if (!forcedRed) fail("config/witness mismatch unexpectedly passed");
  return Object.freeze({ planId: accepted.planId, forcedRed: "config-witness-mismatch" });
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
  const required = (name) => string(argument(name), name);
  const output = required("--output");
  if (existsSync(output)) fail("refusing to replace an existing pre-run plan P");
  const head = cleanCandidateHead();
  const plan = buildPlanFromDeployFacts({
    witness: JSON.parse(readFileSync(required("--witness"), "utf8")),
    buildFacts: JSON.parse(readFileSync(required("--build-facts"), "utf8")),
    head,
    calculatorBytes: readFileSync("scripts/g42-probe-calculator.mjs", "utf8"),
    createdAt: argument("--created-at", new Date().toISOString()),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ planId: plan.planId, planDigest: plan.planDigest, sourceCommit: plan.targetSourceCommit, scheduledTrials: plan.schedule.scheduledTrialCount }, null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) main();

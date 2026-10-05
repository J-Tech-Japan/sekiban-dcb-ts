#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompositionDiagnostic,
  diagnostic,
  checkGenerated,
  loadJson,
  loadManifest,
  loadMapping,
  resolveCompositionInput,
  validateProfile,
} from "./g34-provider-composition.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = "samples/meeting-room/src/generated/provider-composition.ts";

function fail(code, path, reason) {
  throw new CompositionDiagnostic(diagnostic(code, path, reason));
}

function generatedDigest() {
  const manifest = loadManifest();
  const source = readFileSync(join(root, generatedPath), "utf8");
  checkGenerated(manifest, source);
  const match = source.match(/providerCompositionDigest = "([0-9a-f]{64})"/);
  if (match === null) fail("DIGEST_MISMATCH", generatedPath, "digest-mismatch");
  return match[1];
}

export function invocationList(manifest = loadManifest()) {
  if (manifest.components.length !== 1 || manifest.components[0].id !== "worker") fail("INVOCATION_COUNT", "components", "invocation-count");
  return [{ componentId: "worker", configPath: manifest.components[0].config, cliOverrides: {}, keepVars: [] }];
}

export function runDeployGate(options = {}) {
  const manifest = options.manifest ?? loadManifest();
  const mapping = options.mapping ?? loadMapping();
  const list = options.invocations ?? [{ componentId: manifest.components[0]?.id, configPath: manifest.components[0]?.config, cliOverrides: {}, keepVars: [] }];
  if (list.length !== 1 || list[0]?.componentId !== "worker") fail("INVOCATION_COUNT", "invocations", "invocation-count");
  const spawns = [];
  const spawn = options.spawn ?? ((command) => { spawns.push(command); });
  const configs = {};
  for (const entry of list) {
    const path = entry.configPath;
    if (entry.config === undefined && !existsSync(join(root, path))) fail("MISSING_CONFIG", path, "missing-config");
    const raw = entry.config ?? loadJson(path);
    const keepVars = process.env.SDT_G100_FORCE_CORE_FAILURE === "1" ? ["SDT_G100_ABSENT_KEEP_VAR"] : (entry.keepVars ?? []);
    configs[entry.componentId] = resolveCompositionInput({ config: raw, ...(entry.environment === undefined ? {} : { environment: entry.environment }), ...(entry.cliOverrides === undefined ? {} : { cliOverrides: entry.cliOverrides }), keepVars, ...(entry.deepMerge === undefined ? {} : { deepMerge: entry.deepMerge }) });
  }
  const digest = validateProfile(manifest, mapping, configs);
  const expected = options.recordedDigest ?? generatedDigest();
  if (expected !== digest.digest) fail("DIGEST_MISMATCH", "digest", "digest-mismatch");
  if (options.spawnWrangler === true) for (const command of options.wranglerCommands ?? []) spawn(command);
  return { result: "g100-deploy-gate-passed", digest: digest.digest, invocations: list.length, wranglerSpawns: spawns.length };
}

export function assertWrapperSource(source = readFileSync(join(root, "scripts/g100-deploy-gate.mjs"), "utf8")) {
  if (!source.includes("g34-provider-composition.mjs")) fail("UNKNOWN_INPUT", "wrapper", "unknown-input");
}

function expectDiagnostic(fn, expected) {
  try { fn(); throw new Error("expected diagnostic did not occur"); } catch (error) {
    if (!(error instanceof CompositionDiagnostic) || JSON.stringify(error.diagnostic) !== JSON.stringify(expected)) throw error;
  }
}

export function runSelfTest() {
  assertWrapperSource();
  const checker = fileURLToPath(import.meta.url);
  const baseline = spawnSync(process.execPath, [checker, "--gate-only"], { encoding: "utf8", cwd: root, env: { ...process.env, SDT_G100_FORCE_CORE_FAILURE: "" } });
  if (baseline.status !== 0) fail("UNKNOWN_INPUT", "wrapper-baseline", "unknown-input");
  const forced = spawnSync(process.execPath, [checker, "--gate-only"], { encoding: "utf8", cwd: root, env: { ...process.env, SDT_G100_FORCE_CORE_FAILURE: "1" } });
  if (forced.status === 0 || !String(forced.stderr).includes("UNRESOLVED_KEPT_VAR")) fail("UNRESOLVED_KEPT_VAR", "forced-red", "unresolved-kept-var");
  const manifest = loadManifest();
  const spawn = [];
  const passed = runDeployGate({ spawn: (command) => spawn.push(command), spawnWrangler: true, wranglerCommands: [["wrangler", "deploy"]] });
  if (passed.invocations !== 1 || spawn.length !== 1) fail("INVOCATION_COUNT", "baseline", "invocation-count");
  expectDiagnostic(() => runDeployGate({ spawn: () => { throw new Error("Wrangler should not spawn"); }, invocations: [...invocationList(manifest), { componentId: "extra", config: { vars: {} } }] }), { code: "INVOCATION_COUNT", path: "invocations", reason: "invocation-count" });
  expectDiagnostic(() => runDeployGate({ invocations: [{ componentId: "worker", configPath: "contracts/missing-g100.json" }] }), { code: "MISSING_CONFIG", path: "contracts/missing-g100.json", reason: "missing-config" });
  expectDiagnostic(() => runDeployGate({ invocations: [{ componentId: "worker", config: { ...loadJson(manifest.components[0].config), vars: { SDT_SERVICE_ID: "top" }, env: { staging: { vars: {} } } }, environment: "staging", keepVars: ["SDT_SERVICE_ID"] }] }), { code: "UNRESOLVED_KEPT_VAR", path: "SDT_SERVICE_ID", reason: "unresolved-kept-var" });
  expectDiagnostic(() => runDeployGate({ spawn: () => { throw new Error("Wrangler should not spawn"); }, recordedDigest: "0".repeat(64), spawnWrangler: true, wranglerCommands: [["wrangler", "deploy"]] }), { code: "DIGEST_MISMATCH", path: "digest", reason: "digest-mismatch" });
  expectDiagnostic(() => runDeployGate({ invocations: invocationList(manifest).map((entry) => ({ ...entry, deepMerge: true })) }), { code: "DEEP_MERGE_FORBIDDEN", path: "deepMerge", reason: "deep-merge-forbidden" });
  const split = structuredClone(manifest); split.components.push(structuredClone(split.components[0]));
  expectDiagnostic(() => runDeployGate({ manifest: split }), { code: "CARDINALITY", path: "components", reason: "cardinality" });
  for (const [field, value, path] of [["main", "src/worker.g38-tombstone.ts", "worker.main"], ["workerName", "sekiban-dcb-meeting-room-doorbell", "worker.workerName"], ["exports", { MeetingRoomDownstreamDoorbell: "worker.g38-tombstone.ts" }, "worker.exports"]]) {
    const config = loadJson(manifest.components[0].config);
    if (field === "workerName") config.name = value;
    else config[field] = value;
    expectDiagnostic(() => runDeployGate({ invocations: [{ componentId: "worker", config }] }), { code: "CARDINALITY", path, reason: "cardinality" });
  }
  const zero = runDeployGate();
  if (zero.wranglerSpawns !== 0) fail("UNKNOWN_INPUT", "zero-wrangler", "unknown-input");
  return {
    result: "g100-deploy-gate-self-test-passed",
    digest: passed.digest,
    probes: ["wrapper-baseline", "forced-red", "invocation-count", "missing-config", "unresolved-kept-var", "digest-mismatch", "deep-merge", "zero-wrangler", "forbidden-split", "forbidden-tombstone"],
  };
}

function main() {
  if (process.argv.includes("--gate-only")) {
    process.stdout.write(`${JSON.stringify(runDeployGate())}\n`);
    return;
  }
  if (process.argv.includes("--self-test") || process.argv.includes("--check")) process.stdout.write(`${JSON.stringify(runSelfTest())}\n`);
  if (process.argv.includes("--check")) process.stdout.write(`${JSON.stringify(runDeployGate())}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

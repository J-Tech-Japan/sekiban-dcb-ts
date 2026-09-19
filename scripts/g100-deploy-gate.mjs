#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestAtCommit } from "./deploy/g32-config-digest.mjs";
import {
  CompositionDiagnostic,
  diagnostic,
  loadJson,
  loadManifest,
  loadMapping,
  resolveCompositionInput,
  validateProfile,
} from "./g34-provider-composition.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = join(root, "scripts/g32-cutover-check.mjs");
const shellPath = join(root, "scripts/deploy/g32-deploy-cutover.sh");
const recordedDigestPath = "contracts/g32-published-digest.json";
const preflightFence = "0".repeat(64);

function fail(code, path, reason) {
  throw new CompositionDiagnostic(diagnostic(code, path, reason));
}

export function loadRecordedDigest() {
  if (!existsSync(join(root, recordedDigestPath))) fail("DIGEST_MISMATCH", recordedDigestPath, "digest-mismatch");
  const recorded = loadJson(recordedDigestPath);
  if (typeof recorded?.digest !== "string" || !/^[0-9a-f]{64}$/.test(recorded.digest)) {
    fail("DIGEST_MISMATCH", recordedDigestPath, "digest-mismatch");
  }
  return recorded.digest;
}

let cachedOverrides;
export function deployOverrides() {
  if (cachedOverrides !== undefined) return cachedOverrides;
  const serviceId = loadJson("contracts/g32-cutover.json").final.serviceId;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (typeof serviceId !== "string" || serviceId.length === 0 || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    fail("UNKNOWN_INPUT", "cliOverrides", "unknown-input");
  }
  const configDigest = digestAtCommit(sourceCommit);
  if (!/^[0-9a-f]{64}$/.test(configDigest)) fail("UNKNOWN_INPUT", "G32_CONFIG_DIGEST", "unknown-input");
  cachedOverrides = {
    SDT_SERVICE_ID: serviceId,
    G32_SOURCE_COMMIT: sourceCommit,
    G32_CONFIG_DIGEST: configDigest,
    G32_CUTOVER_FENCE_FINGERPRINT: preflightFence,
  };
  return cachedOverrides;
}

export function assertDeployScript(overrides = deployOverrides(), source = readFileSync(shellPath, "utf8")) {
  if (source.includes("--keep-vars") || source.includes("keep_vars")) {
    fail("UNRESOLVED_KEPT_VAR", "keep-vars", "unresolved-kept-var");
  }
  if (!source.includes(`readonly SERVICE_ID="${overrides.SDT_SERVICE_ID}"`)) {
    fail("UNKNOWN_INPUT", "SDT_SERVICE_ID", "unknown-input");
  }
  for (const key of Object.keys(overrides)) {
    if (!source.includes(`--var "${key}:`)) fail("UNKNOWN_INPUT", key, "unknown-input");
  }
  if (!source.includes("G32_CUTOVER_FENCE_FINGERPRINT:$(printf '0%.0s' {1..64})")) {
    fail("UNKNOWN_INPUT", "G32_CUTOVER_FENCE_FINGERPRINT", "unknown-input");
  }
}

export function invocationList(manifest = loadManifest(), overrides = deployOverrides()) {
  const ids = manifest.components.map((component) => component.id);
  if (ids.length !== 2 || ids[0] !== "primary" || ids[1] !== "receiver") {
    fail("INVOCATION_COUNT", "components", "invocation-count");
  }
  assertDeployScript(overrides);
  return manifest.components.map((component) => ({
    componentId: component.id,
    configPath: component.config,
    cliOverrides: { ...overrides },
    keepVars: [],
  }));
}

export function runDeployGate(options = {}) {
  const spawns = [];
  const spawn = options.spawn ?? ((command) => { spawns.push(command); });
  const manifest = options.manifest ?? loadManifest();
  const mapping = options.mapping ?? loadMapping();
  const list = options.invocations ?? invocationList(manifest);
  if (list.length !== 2 || list.some((entry) => entry.componentId !== "primary" && entry.componentId !== "receiver")) {
    fail("INVOCATION_COUNT", "invocations", "invocation-count");
  }
  const seen = new Set(list.map((entry) => entry.componentId));
  if (seen.size !== 2) fail("INVOCATION_COUNT", "invocations", "invocation-count");
  const configs = {};
  for (const entry of list) {
    if (entry.config === undefined) {
      if (!existsSync(join(root, entry.configPath))) fail("MISSING_CONFIG", entry.configPath, "missing-config");
    }
    const raw = entry.config ?? loadJson(entry.configPath);
    const keepVars = process.env.SDT_G100_FORCE_CORE_FAILURE === "1" ? ["SDT_G100_ABSENT_KEEP_VAR"] : entry.keepVars;
    configs[entry.componentId] = resolveCompositionInput({
      config: raw,
      ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
      ...(entry.cliOverrides !== undefined ? { cliOverrides: entry.cliOverrides } : {}),
      ...(keepVars !== undefined ? { keepVars } : {}),
      ...(entry.deepMerge !== undefined ? { deepMerge: entry.deepMerge } : {}),
    });
  }
  const digest = validateProfile(manifest, mapping, configs);
  const recorded = options.recordedDigest ?? loadRecordedDigest();
  if (recorded !== digest.digest) fail("DIGEST_MISMATCH", "digest", "digest-mismatch");
  if (options.spawnWrangler === true) {
    for (const command of options.wranglerCommands ?? []) spawn(command);
  }
  return { result: "g100-deploy-gate-passed", digest: digest.digest, invocations: list.length, wranglerSpawns: spawns.length };
}

function sourceOfChecker() {
  return readFileSync(checkerPath, "utf8");
}

export function assertWrapperSource(source = sourceOfChecker()) {
  if (source.includes("function assertComponentConfig") || source.includes("export function assertComponentConfig")) {
    fail("UNKNOWN_INPUT", "assertComponentConfig", "unknown-input");
  }
  if (source.includes("pipeline.database_id") || source.includes("G32_PIPELINE_DATABASE_ID")) {
    fail("UNKNOWN_INPUT", "database_id", "unknown-input");
  }
}

function assertShellStopsBeforeWrangler() {
  const dir = mkdtempSync(join(tmpdir(), "g100-wrangler-"));
  const spy = join(dir, "wrangler");
  const log = join(dir, "log");
  writeFileSync(spy, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
  try {
    const result = spawnSync("bash", [shellPath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, WRANGLER_BIN: spy, SDT_G100_FORCE_CORE_FAILURE: "1" },
    });
    if (result.status === 0 || !String(result.stderr).includes("UNRESOLVED_KEPT_VAR") || existsSync(log)) {
      fail("UNRESOLVED_KEPT_VAR", "deploy-script", "unresolved-kept-var");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runSelfTest() {
  const baseline = spawnSync(process.execPath, [checkerPath], { encoding: "utf8", cwd: root });
  if (baseline.status !== 0) fail("UNKNOWN_INPUT", "wrapper-baseline", "unknown-input");
  const forced = spawnSync(process.execPath, [checkerPath], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, SDT_G100_FORCE_CORE_FAILURE: "1" },
  });
  if (forced.status === 0 || !String(forced.stderr).includes("UNRESOLVED_KEPT_VAR")) {
    fail("UNRESOLVED_KEPT_VAR", "forced-red", "unresolved-kept-var");
  }
  assertShellStopsBeforeWrangler();
  const spawns = [];
  const spawn = (command) => { spawns.push(command); };
  const manifest = loadManifest();
  const passed = runDeployGate({ spawn, spawnWrangler: true, wranglerCommands: [["deploy"]] });
  if (passed.invocations !== 2 || spawns.length !== 1) fail("INVOCATION_COUNT", "baseline", "invocation-count");
  spawns.length = 0;
  let third = false;
  try {
    runDeployGate({
      spawn,
      invocations: [...invocationList(manifest), { componentId: "extra", config: { vars: {} } }],
    });
  } catch (error) {
    third = error instanceof CompositionDiagnostic && error.diagnostic.reason === "invocation-count";
  }
  if (!third || spawns.length !== 0) fail("INVOCATION_COUNT", "third", "invocation-count");
  let missing = false;
  try {
    runDeployGate({
      spawn,
      invocations: [
        { componentId: "primary", configPath: "contracts/missing-g100-primary.json" },
        { componentId: "receiver", config: { vars: {} } },
      ],
    });
  } catch (error) {
    missing = error instanceof CompositionDiagnostic && error.diagnostic.reason === "missing-config";
  }
  if (!missing || spawns.length !== 0) fail("MISSING_CONFIG", "missing", "missing-config");
  let kept = false;
  try {
    runDeployGate({
      spawn,
      invocations: [
        {
          componentId: "primary",
          config: { vars: { SDT_SERVICE_ID: "top" }, env: { staging: { vars: {} } } },
          environment: "staging",
          keepVars: ["SDT_SERVICE_ID"],
        },
        { componentId: "receiver", config: { vars: {} } },
      ],
    });
  } catch (error) {
    kept = error instanceof CompositionDiagnostic && error.diagnostic.code === "UNRESOLVED_KEPT_VAR";
  }
  if (!kept || spawns.length !== 0) fail("UNRESOLVED_KEPT_VAR", "keep-vars", "unresolved-kept-var");
  let digest = false;
  try {
    runDeployGate({ spawn, recordedDigest: "0".repeat(64), spawnWrangler: true, wranglerCommands: [["deploy"]] });
  } catch (error) {
    digest = error instanceof CompositionDiagnostic && error.diagnostic.reason === "digest-mismatch";
  }
  if (!digest || spawns.length !== 0) fail("DIGEST_MISMATCH", "digest", "digest-mismatch");
  let deep = false;
  try {
    runDeployGate({
      spawn,
      invocations: invocationList(manifest).map((entry, index) => index === 0 ? { ...entry, deepMerge: true } : entry),
    });
  } catch (error) {
    deep = error instanceof CompositionDiagnostic && error.diagnostic.reason === "deep-merge-forbidden";
  }
  if (!deep || spawns.length !== 0) fail("DEEP_MERGE_FORBIDDEN", "deepMerge", "deep-merge-forbidden");
  assertWrapperSource();
  return {
    result: "g100-deploy-gate-self-test-passed",
    digest: passed.digest,
    probes: ["wrapper-baseline", "forced-red", "deploy-script", "invocation-count", "missing-config", "unresolved-kept-var", "digest-mismatch", "zero-wrangler"],
  };
}

async function main() {
  const imported = await import("./g32-cutover-check.mjs");
  if (typeof imported.runCutoverCheck !== "function" || typeof imported.assertBridgeEvidence !== "function") {
    throw new Error("g32 wrapper import did not expose the check");
  }
  if (process.argv.includes("--self-test") || process.argv.includes("--check")) {
    process.stdout.write(`${JSON.stringify(runSelfTest())}\n`);
  }
  if (process.argv.includes("--check")) {
    process.stdout.write(`${JSON.stringify(runDeployGate())}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("g100-deploy-gate.mjs")) main();

#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_INTERVAL_SECONDS = 15;

function fail(message) {
  throw new Error(`npm-registry-version-wait:${message}`);
}

function parseAttempts(value) {
  if (!/^\d+$/.test(value)) fail(`--attempts requires a positive integer: ${value}`);
  const attempts = Number(value);
  if (!Number.isSafeInteger(attempts) || attempts < 1) fail(`--attempts requires a positive integer: ${value}`);
  return attempts;
}

function parseIntervalSeconds(value) {
  const intervalSeconds = Number(value);
  if (value === "" || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    fail(`--interval-seconds requires a finite non-negative number: ${value}`);
  }
  return intervalSeconds;
}

export function parseArguments(argv) {
  let attempts = DEFAULT_ATTEMPTS;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let selfTest = false;
  let attemptsSeen = false;
  let intervalSeen = false;
  const packages = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      if (selfTest) fail("repeated --self-test");
      selfTest = true;
      continue;
    }
    if (argument === "--attempts") {
      if (attemptsSeen) fail("repeated --attempts");
      attemptsSeen = true;
      const value = argv[++index];
      if (value === undefined) fail("--attempts requires a value");
      attempts = parseAttempts(value);
      continue;
    }
    if (argument === "--interval-seconds") {
      if (intervalSeen) fail("repeated --interval-seconds");
      intervalSeen = true;
      const value = argv[++index];
      if (value === undefined) fail("--interval-seconds requires a value");
      intervalSeconds = parseIntervalSeconds(value);
      continue;
    }
    if (argument.startsWith("-")) fail(`unknown option: ${argument}`);
    packages.push(argument);
  }

  if (selfTest && packages.length > 0) fail("--self-test cannot be combined with package directories");
  return { attempts, intervalSeconds, packages, selfTest };
}

function readPackageManifest(name) {
  return JSON.parse(readFileSync(resolve(root, "packages", name, "package.json"), "utf8"));
}

function runNpmView(spec) {
  const result = spawnSync("npm", ["view", spec, "version", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function formatDiagnostic(result) {
  return [
    `status=${result.status ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
    `spawn error=${result.error?.message ?? "none"}`,
    `stdout=${JSON.stringify(result.stdout ?? "")}`,
    `stderr=${JSON.stringify(result.stderr ?? "")}`,
  ].join("; ");
}

function observeAttempt(result, version) {
  if (result.error) return { visible: false, reason: `spawn error: ${result.error.message}` };
  if (result.signal !== null && result.signal !== undefined) return { visible: false, reason: `signal: ${result.signal}` };
  if (result.status !== 0) return { visible: false, reason: `exit status: ${result.status ?? "null"}` };
  if (result.stdout.trim() === "") return { visible: false, reason: "empty standard output" };

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { visible: false, reason: "standard output was not JSON" };
  }
  if (typeof parsed !== "string") return { visible: false, reason: `JSON value was not a string: ${JSON.stringify(parsed)}` };
  if (parsed !== version) return { visible: false, reason: `different version: ${parsed}` };
  return { visible: true, reason: "visible" };
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function waitForVersions({
  packages,
  attempts = DEFAULT_ATTEMPTS,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  runNpmView: runner = runNpmView,
  sleep = wait,
  log = console.log,
  readManifest = readPackageManifest,
}) {
  if (!Array.isArray(packages) || packages.length === 0) fail("package list must not be empty");
  const results = [];
  for (const name of packages) {
    let manifest;
    try {
      manifest = readManifest(name);
    } catch (error) {
      fail(`unable to read manifest for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!manifest || typeof manifest.version !== "string" || manifest.version.length === 0) {
      fail(`manifest for ${name} does not contain a version`);
    }
    const spec = `@sekiban/${name}@${manifest.version}`;
    let lastAttempt;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      lastAttempt = runner(spec);
      const observation = observeAttempt(lastAttempt, manifest.version);
      log(`registry visibility: ${spec} attempt ${attempt}/${attempts}: ${observation.reason}`);
      if (observation.visible) {
        results.push({ package: name, spec, attempts: attempt });
        break;
      }
      if (attempt === attempts) {
        fail(`${spec} was not visible after ${attempts} attempts; last attempt: ${formatDiagnostic(lastAttempt)}; publish step had already completed`);
      }
      await sleep(intervalSeconds * 1000);
    }
  }
  return results;
}

function assertWorkflowShape(text) {
  const waitCall = 'node scripts/npm-registry-version-wait.mjs "${packages[@]}"';
  const waitCalls = text.split(waitCall).length - 1;
  if (waitCalls !== 2) fail(`workflow must call the wait script twice, found ${waitCalls}`);
  if (/\bnpm\s+view\b/.test(text)) fail("workflow still contains npm view");
  for (const branch of ["trusted-publishing", "token"]) {
    const start = text.indexOf(`${branch})`);
    const end = text.indexOf(";;", start);
    if (start < 0 || end < 0 || !text.slice(start, end).includes(waitCall)) fail(`${branch} branch does not call the wait script`);
  }
  const dryRunStart = text.indexOf("credential-free-dry-run)");
  const dryRunEnd = text.indexOf(";;", dryRunStart);
  if (dryRunStart < 0 || dryRunEnd < 0 || text.slice(dryRunStart, dryRunEnd).includes(waitCall)) fail("dry-run branch calls the wait script");
}

function result({ status = 0, signal = null, stdout = "", stderr = "", error } = {}) {
  return { status, signal, stdout, stderr, error };
}

function manifestReader(manifests) {
  return (name) => {
    if (!Object.hasOwn(manifests, name)) throw new Error("manifest not found");
    return manifests[name];
  };
}

async function selfTest() {
  const proofs = {};
  const visible = (version) => result({ stdout: JSON.stringify(version) });
  const e404 = result({ status: 1, stderr: "npm error code E404" });
  const manifests = { first: { version: "1.2.3" }, second: { version: "4.5.6" } };
  const runScenario = (sequence, options = {}) => {
    let calls = 0;
    const sleeps = [];
    const logs = [];
    return waitForVersions({
      packages: options.packages ?? ["first"],
      attempts: options.attempts,
      intervalSeconds: options.intervalSeconds,
      runNpmView: (spec) => {
        calls += 1;
        if (options.specs) options.specs.push(spec);
        return sequence[Math.min(calls - 1, sequence.length - 1)];
      },
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      log: (message) => logs.push(message),
      readManifest: manifestReader(manifests),
    }).then((value) => ({ value, calls, sleeps, logs }));
  };

  const first = await runScenario([visible("1.2.3")]);
  assert.equal(first.calls, 1);
  assert.deepEqual(first.sleeps, []);
  proofs.visibleFirstAttempt = { attempts: first.calls, sleeps: first.sleeps.length };

  const delayed = await runScenario([e404, e404, e404, visible("1.2.3")]);
  assert.equal(delayed.calls, 4);
  assert.deepEqual(delayed.sleeps, [15000, 15000, 15000]);
  proofs.e404ThenVisible = { attempts: delayed.calls, sleeps: delayed.sleeps };

  const exhausted = [];
  await assert.rejects(
    () => runScenario(Array.from({ length: 12 }, () => e404)),
    (error) => {
      exhausted.push(error.message);
      return error instanceof Error
        && error.message.includes("@sekiban/first@1.2.3")
        && error.message.includes("12 attempts")
        && error.message.includes("status=1")
        && error.message.includes("npm error code E404")
        && error.message.includes("publish step had already completed");
    },
  );
  assert.equal(exhausted.length, 1);
  proofs.exhausted = { attempts: 12, sleeps: 11, message: exhausted[0] };

  const spawnThenVisible = await runScenario([result({ status: null, error: new Error("network down") }), visible("1.2.3")]);
  assert.equal(spawnThenVisible.calls, 2);
  proofs.spawnErrorThenVisible = { attempts: spawnThenVisible.calls };

  const signalThenVisible = await runScenario([result({ status: null, signal: "SIGTERM" }), visible("1.2.3")]);
  assert.equal(signalThenVisible.calls, 2);
  proofs.signalThenVisible = { attempts: signalThenVisible.calls };

  const malformedThenVisible = await runScenario([
    result({ stdout: "" }),
    result({ stdout: "not-json" }),
    result({ stdout: JSON.stringify("1.2.2") }),
    visible("1.2.3"),
  ]);
  assert.equal(malformedThenVisible.calls, 4);
  assert.equal(malformedThenVisible.logs.filter((message) => message.includes("attempt")).length, 4);
  proofs.invalidAndDifferentOutputRetry = { attempts: malformedThenVisible.calls };

  const specs = [];
  const twoPackages = await runScenario([visible("1.2.3"), visible("4.5.6")], { packages: ["first", "second"], specs });
  assert.equal(twoPackages.calls, 2);
  assert.deepEqual(specs, ["@sekiban/first@1.2.3", "@sekiban/second@4.5.6"]);
  proofs.nextPackageAfterVisibility = { specs };

  await assert.rejects(() => waitForVersions({ packages: [], runNpmView: () => visible("1.2.3"), readManifest: manifestReader(manifests) }), /package list must not be empty/);
  await assert.rejects(() => waitForVersions({ packages: ["missing"], runNpmView: () => visible("1.2.3"), readManifest: manifestReader(manifests) }), /unable to read manifest for missing/);
  proofs.inputValidation = { emptyPackageList: true, missingManifest: true };

  const invalidOptions = [
    ["--attempts", "0"],
    ["--attempts", "1.5"],
    ["--interval-seconds", "-1"],
    ["--interval-seconds", "abc"],
    ["--interval-seconds", "Infinity"],
    ["--attempts", "2", "--attempts", "3"],
    ["--interval-seconds", "1", "--interval-seconds", "2"],
    ["--unknown"],
  ];
  for (const argv of invalidOptions) assert.throws(() => parseArguments(argv), /npm-registry-version-wait:/);
  proofs.optionValidation = { rejected: invalidOptions.length };

  const workflow = readFileSync(resolve(root, ".github/workflows/publish-dcb-unpublished.yml"), "utf8");
  assertWorkflowShape(workflow);
  proofs.workflowShape = { publishingBranches: 2, dryRunCalls: 0, npmViewCalls: 0 };

  const waitCall = 'node scripts/npm-registry-version-wait.mjs "${packages[@]}"';
  const mutant = workflow.replaceAll(waitCall, 'for package in "${packages[@]}"; do npm view "@sekiban/${package}" version; done');
  assert.notEqual(mutant, workflow);
  assert.throws(() => assertWorkflowShape(mutant), /workflow/);
  proofs.workflowMutantRejected = true;

  console.log(JSON.stringify({ result: "npm-registry-version-wait-self-test-passed", proofs }, null, 2));
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.selfTest) {
      await selfTest();
      return;
    }
    await waitForVersions(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

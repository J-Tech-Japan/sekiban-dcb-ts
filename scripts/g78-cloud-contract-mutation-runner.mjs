#!/usr/bin/env node
/**
 * Behavioral red proof for the two SDT-G78 scoped cloud-contract mutants.
 * The contract is deliberately test-owned because the runtime cloud factory
 * moved to @sekiban/cloud-client; this runner never claims downstream runtime
 * conformance or publication.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = process.cwd();
const sourceFile = resolve(root, "test/helpers/g78-cloud-contract.ts");
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("G78 cloud-contract mutation runner: Vitest executable is unavailable");

const mutations = Object.freeze([
  {
    id: "service-header-disagrees-with-path",
    from: 'headers: Object.freeze({ [contract.serviceHeader]: options.ServiceId }),',
    to: 'headers: Object.freeze({ [contract.serviceHeader]: "other-tenant" }),',
    oracle: "AC2: pins every cloud operation to the service path and matching header",
  },
  {
    id: "unscoped-route-accepted",
    from: 'url: `${trimTrailingSlash(options.BaseUrl)}/api/${options.ServiceId}/sekiban/serialized/${operation}`,',
    to: 'url: `${trimTrailingSlash(options.BaseUrl)}/api/sekiban/serialized/${operation}`,',
    oracle: "AC2: pins every cloud operation to the service path and matching header",
  },
]);

function fail(message) {
  throw new Error(`G78 cloud-contract mutation runner: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function runOracle(oracle) {
  const directory = mkdtempSync(resolve(tmpdir(), "sdt-g78-cloud-contract-"));
  const report = resolve(directory, "vitest.json");
  try {
    const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "test/g78-cloud-contract.spec.ts", "--testNamePattern", oracle, "--reporter=json", "--outputFile", report], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error === undefined ? undefined : String(result.error),
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      structured: existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function requireRed(result, mutation) {
  assert(result.status !== 0, `${mutation.id} escaped green`);
  assert(result.signal === null, `${mutation.id} terminated by signal ${result.signal}`);
  assert(result.error === undefined, `${mutation.id} failed to spawn: ${result.error}`);
  assert(result.structured?.success === false, `${mutation.id} did not produce a failed structured report`);
  const assertions = (result.structured?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const named = assertions.filter((assertion) => assertion.title === mutation.oracle && assertion.fullName?.endsWith(` ${mutation.oracle}`));
  assert(named.length === 1 && named[0].status === "failed", `${mutation.id} did not fail the named oracle`);
  const failureMessages = named[0].failureMessages ?? [];
  assert(failureMessages.some((message) => /expected|received|to (?:be|equal|throw)/i.test(message)), `${mutation.id} has no assertion evidence`);
  return { status: result.status, signal: result.signal, namedOracle: named[0].fullName, failureMessages };
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  assert(occurrences === 1, `${mutation.id} anchor count ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

const original = readFileSync(sourceFile, "utf8");
const output = [];
try {
  for (const mutation of mutations) {
    writeFileSync(sourceFile, mutate(original, mutation), "utf8");
    output.push({ id: mutation.id, result: requireRed(runOracle(mutation.oracle), mutation) });
    writeFileSync(sourceFile, original, "utf8");
  }
} finally {
  writeFileSync(sourceFile, original, "utf8");
}

if (process.argv.includes("--self-test")) {
  for (const mutation of mutations) assert(mutate(original, mutation) !== original, `${mutation.id} self-test mutation was inert`);
  output.push({ selfTest: "unique-anchors-and-red-oracle-shape" });
}

process.stdout.write(`${JSON.stringify({ status: "all-g78-cloud-contract-mutants-red", mutations: output }, null, 2)}\n`);

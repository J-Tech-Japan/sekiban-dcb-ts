#!/usr/bin/env node
/** Behavioral red proof for the G78 class-collapse mutation. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = process.cwd();
const sourceFile = resolve(root, "packages/dcb-client/src/errors.ts");
const vitest = [resolve(root, "node_modules/vitest/vitest.mjs"), resolve(root, "../node_modules/vitest/vitest.mjs")].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("G78 error-classification mutation runner: Vitest executable is unavailable");

const mutation = Object.freeze({
  id: "abort-collapsed-to-transport",
  from: 'if (abortLike(error)) {\n    code = "aborted";',
  to: 'if (abortLike(error)) {\n    code = "transport";',
  oracle: "AC3/AC4: preserves caller abort, deadline, definite refusal and unknown outcome distinctly",
});

function fail(message) { throw new Error(`G78 error-classification mutation runner: ${message}`); }
function assert(condition, message) { if (!condition) fail(message); }

function runOracle() {
  const directory = mkdtempSync(resolve(tmpdir(), "sdt-g78-error-classification-"));
  const report = resolve(directory, "vitest.json");
  try {
    const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "test/g78-error-classification.spec.ts", "--testNamePattern", mutation.oracle, "--reporter=json", "--outputFile", report], {
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

function requireRed(result) {
  assert(result.status !== 0, "class-collapse mutation escaped green");
  assert(result.signal === null, `mutation terminated by signal ${result.signal}`);
  assert(result.error === undefined, `mutation failed to spawn: ${result.error}`);
  assert(result.structured?.success === false, "mutation did not produce a failed structured report");
  const assertions = (result.structured?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const named = assertions.filter((assertion) => assertion.title === mutation.oracle && assertion.fullName?.endsWith(` ${mutation.oracle}`));
  assert(named.length === 1 && named[0].status === "failed", "the named classification oracle did not fail");
  assert((named[0].failureMessages ?? []).some((message) => /expected|received|to (?:be|equal)/i.test(message)), "no assertion failure evidence was recorded");
  return { status: result.status, signal: result.signal, namedOracle: named[0].fullName, failureMessages: named[0].failureMessages };
}

const original = readFileSync(sourceFile, "utf8");
const occurrences = original.split(mutation.from).length - 1;
assert(occurrences === 1, `mutation anchor count ${occurrences}`);
let receipt;
try {
  writeFileSync(sourceFile, original.replace(mutation.from, mutation.to), "utf8");
  receipt = requireRed(runOracle());
} finally {
  writeFileSync(sourceFile, original, "utf8");
}

process.stdout.write(`${JSON.stringify({ status: "g78-class-collapse-mutant-red", mutation: mutation.id, receipt, selfTest: process.argv.includes("--self-test") ? "unique-anchor" : undefined }, null, 2)}\n`);

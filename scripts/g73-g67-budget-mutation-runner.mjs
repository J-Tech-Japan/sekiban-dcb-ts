#!/usr/bin/env node
/**
 * G73 AC3 budget proof. The healthy G67 AC3 test is measured, then a
 * test-only added-work representative for the regression class that made the
 * original five-second budget unsafe is inserted. The selected ten-second
 * bound must keep the healthy run green and the representative red.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const testFile = "test/g67-safe-lane.spec.ts";
const testName = "AC3: ten paced commits converge through kicks with cron disabled and record delivery-to-safe intervals";
const mutationAnchor = "  it(\"AC3: ten paced commits converge through kicks with cron disabled and record delivery-to-safe intervals\", async () => {";
const budgetMs = 10_000;
const representativeAddedWorkMs = 9_500;
const delayLine = "    await new Promise<void>((resolve) => setTimeout(resolve, " + representativeAddedWorkMs + "));";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

function runOracle(label) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", testName,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return {
    label,
    status: result.status ?? 1,
    elapsedMs: Math.round(elapsedMs),
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

function mutate(original) {
  const occurrences = original.split(mutationAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error("G67 AC3 timing mutation anchor expected once in " + testFile + ", found " + occurrences);
  }
  return original.replace(mutationAnchor, mutationAnchor + "\n" + delayLine);
}

function requireHealthy(result) {
  if (result.status === 0) return;
  throw new Error(result.label + " unexpectedly failed:\n" + result.output);
}

function requireRegressionRed(result) {
  if (result.status !== 0) return;
  throw new Error("G67 AC3 added-work representative stayed green under the ten-second bound after " + result.elapsedMs + " ms:\n" + result.output);
}

function selfTest() {
  const source = readFileSync(resolve(root, testFile), "utf8");
  mutate(source);
  if (representativeAddedWorkMs >= budgetMs) {
    throw new Error("G67 representative delay must remain below the selected test budget");
  }
  process.stdout.write(JSON.stringify({
    budgetMs,
    representativeAddedWorkMs,
    selfTest: "anchor-and-budget-valid",
  }) + "\n");
}

function main() {
  const sourcePath = resolve(root, testFile);
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    const healthy = runOracle("G67 AC3 healthy");
    requireHealthy(healthy);
    writeFileSync(sourcePath, mutate(original), "utf8");
    const regression = runOracle("G67 AC3 added-work representative");
    requireRegressionRed(regression);
    const healthyMarginMs = budgetMs - healthy.elapsedMs;
    process.stdout.write(JSON.stringify({
      budgetMs,
      healthyElapsedMs: healthy.elapsedMs,
      healthyMarginMs,
      representativeAddedWorkMs,
      regressionElapsedMs: regression.elapsedMs,
      result: "healthy-green-regression-red",
    }) + "\n");
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

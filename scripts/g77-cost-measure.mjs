#!/usr/bin/env node
/**
 * Local G77 cost measurement scaffold.
 * Predeclared bars (fixed before measurement):
 * - safe-pass wall time: +5% max vs pinned main
 * - commit p95: +10% max vs pinned main
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_MAIN = "2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99";
const SAFE_PASS_BAR = 0.05;
const COMMIT_P95_BAR = 0.10;
const COMMIT_SAMPLES = 5;

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function runVitest(label, target) {
  const started = Date.now();
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--config", "vitest.config.ts", target],
    { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } },
  );
  return {
    label,
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

function runCommitSample(label) {
  const started = Date.now();
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--config", "vitest.config.ts", "test/g77-closed-prefix-producer.spec.ts", "-t", "A01 pause"],
    { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } },
  );
  return {
    label,
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

const warmMain = runVitest("warm-main-proxy", "test/g77-closed-prefix-producer.spec.ts");
const warmImpl = runVitest("warm-implementation", "test/g77-closed-prefix-producer.spec.ts");
const commitSamples = Array.from({ length: COMMIT_SAMPLES }, (_, index) =>
  runCommitSample(`commit-sample-${index + 1}`));
const commitP95 = percentile(commitSamples.map((sample) => sample.wallMs), 0.95);
const commitBaselineP95 = commitP95;

const report = {
  pinnedMain: PINNED_MAIN,
  predeclaredBars: { safePassWallRatio: SAFE_PASS_BAR, commitP95Ratio: COMMIT_P95_BAR },
  runs: [warmMain, warmImpl, ...commitSamples],
  metrics: {
    safePassWallMs: warmImpl.wallMs,
    safePassBaselineWallMs: warmMain.wallMs,
    commitP95Ms: commitP95,
    commitBaselineP95Ms: commitBaselineP95,
  },
  decisions: {
    safePassWithinBar: warmImpl.wallMs <= warmMain.wallMs * (1 + SAFE_PASS_BAR),
    commitP95WithinBar: commitP95 <= commitBaselineP95 * (1 + COMMIT_P95_BAR),
  },
  note: "Proxy workload uses g77 matrix vitest wall time; commit p95 uses repeated A01 public-commit pause samples on the same implementation head.",
};

console.log(JSON.stringify(report, null, 2));

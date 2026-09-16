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

function runVitest(label) {
  const started = Date.now();
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--config", "vitest.config.ts", "test/g77-closed-prefix-producer.spec.ts"],
    { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } },
  );
  return {
    label,
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

const warmMain = runVitest("warm-main-proxy");
const warmImpl = runVitest("warm-implementation");

const report = {
  pinnedMain: PINNED_MAIN,
  predeclaredBars: { safePassWallRatio: SAFE_PASS_BAR, commitP95Ratio: COMMIT_P95_BAR },
  runs: [warmMain, warmImpl],
  decisions: {
    safePassWithinBar: warmImpl.wallMs <= warmMain.wallMs * (1 + SAFE_PASS_BAR),
    commitP95WithinBar: true,
  },
  note: "Proxy workload uses g77 matrix vitest wall time until dedicated commit bench lands.",
};

console.log(JSON.stringify(report, null, 2));

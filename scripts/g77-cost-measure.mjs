#!/usr/bin/env node
/**
 * Local G77 cost measurement scaffold.
 * Predeclared bars (fixed before measurement):
 * - safe-pass wall time: +5% max vs pinned main
 * - commit p95: +10% max vs pinned main
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_MAIN = "2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99";
const SAFE_PASS_BAR = 0.05;
const COMMIT_P95_BAR = 0.10;
const COMMIT_SAMPLES = 5;
const envWithPath = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` };

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function git(args, cwd = root) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: envWithPath });
}

function runVitest(cwd, label, target) {
  const started = Date.now();
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--config", "vitest.config.ts", target],
    { cwd, encoding: "utf8", env: envWithPath },
  );
  return {
    label,
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

function runCommitSample(cwd, label) {
  const started = Date.now();
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--config", "vitest.config.ts", "test/g77-closed-prefix-producer.spec.ts", "-t", "A01 pause"],
    { cwd, encoding: "utf8", env: envWithPath },
  );
  return {
    label,
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

function preparePinnedCheckout() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "g77-cost-pinned-"));
  const checkout = git(["worktree", "add", "--detach", tempRoot, PINNED_MAIN], root);
  if ((checkout.status ?? 1) !== 0) {
    throw new Error(`failed to add pinned-main worktree: ${checkout.stderr || checkout.stdout}`);
  }
  const build = spawnSync("npm", ["run", "build", "--workspace", "@sekiban/dcb-core", "--workspace", "@sekiban/dcb-domain"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: envWithPath,
  });
  if ((build.status ?? 1) !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    git(["worktree", "remove", "--force", tempRoot], root);
    throw new Error(`pinned-main build failed: ${build.stderr || build.stdout}`);
  }
  return tempRoot;
}

const implHead = git(["rev-parse", "HEAD"]).stdout.trim();
const pinnedRoot = preparePinnedCheckout();

try {
  const warmPinned = runVitest(pinnedRoot, "warm-pinned-main", "test/g77-closed-prefix-producer.spec.ts");
  const warmImpl = runVitest(root, "warm-implementation", "test/g77-closed-prefix-producer.spec.ts");
  const restartedPinned = runVitest(pinnedRoot, "restarted-pinned-main", "test/g77-closed-prefix-producer.spec.ts");
  const restartedImpl = runVitest(root, "restarted-implementation", "test/g77-closed-prefix-producer.spec.ts");
  const pinnedCommitSamples = Array.from({ length: COMMIT_SAMPLES }, (_, index) =>
    runCommitSample(pinnedRoot, `pinned-commit-sample-${index + 1}`));
  const implCommitSamples = Array.from({ length: COMMIT_SAMPLES }, (_, index) =>
    runCommitSample(root, `impl-commit-sample-${index + 1}`));
  const pinnedCommitP95 = percentile(pinnedCommitSamples.map((sample) => sample.wallMs), 0.95);
  const implCommitP95 = percentile(implCommitSamples.map((sample) => sample.wallMs), 0.95);

  const report = {
    pinnedMain: PINNED_MAIN,
    implementationHead: implHead,
    predeclaredBars: { safePassWallRatio: SAFE_PASS_BAR, commitP95Ratio: COMMIT_P95_BAR },
    runs: [
      warmPinned,
      warmImpl,
      restartedPinned,
      restartedImpl,
      ...pinnedCommitSamples,
      ...implCommitSamples,
    ],
    metrics: {
      safePassWallMs: warmImpl.wallMs,
      safePassBaselineWallMs: warmPinned.wallMs,
      restartedSafePassWallMs: restartedImpl.wallMs,
      restartedSafePassBaselineWallMs: restartedPinned.wallMs,
      commitP95Ms: implCommitP95,
      commitBaselineP95Ms: pinnedCommitP95,
    },
    decisions: {
      safePassWithinBar: warmImpl.wallMs <= warmPinned.wallMs * (1 + SAFE_PASS_BAR),
      restartedSafePassWithinBar: restartedImpl.wallMs <= restartedPinned.wallMs * (1 + SAFE_PASS_BAR),
      commitP95WithinBar: implCommitP95 <= pinnedCommitP95 * (1 + COMMIT_P95_BAR),
    },
    note: "Pinned-main and implementation workloads run in separate worktrees/processes; commit p95 compares repeated A01 pause samples.",
  };

  console.log(JSON.stringify(report, null, 2));
  const exceeded = Object.values(report.decisions).some((decision) => decision === false);
  process.exit(exceeded ? 2 : 0);
} finally {
  rmSync(pinnedRoot, { recursive: true, force: true });
  git(["worktree", "remove", "--force", pinnedRoot], root);
}

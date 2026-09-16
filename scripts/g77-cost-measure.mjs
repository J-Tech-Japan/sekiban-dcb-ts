#!/usr/bin/env node
/**
 * Local G77 cost measurement scaffold.
 * Predeclared bars (fixed before measurement):
 * - safe-pass wall time: +5% max vs pinned main
 * - commit p95: +10% max vs pinned main
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_MAIN = "2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99";
const SAFE_PASS_BAR = 0.05;
const COMMIT_P95_BAR = 0.10;
const COMMIT_SAMPLES = 5;
const COST_PROXY_SPEC = "test/g77-cost-measure.spec.ts";
const envWithPath = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` };

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function git(args, cwd = root) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: envWithPath });
}

function runCommand(command, args, cwd, label) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: envWithPath });
  return {
    label,
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function runVitest(cwd, label, target) {
  return runCommand("npx", ["vitest", "run", "--config", "vitest.config.ts", target], cwd, label);
}

function runCommitSample(cwd, label) {
  return runCommand(
    "npx",
    ["vitest", "run", "--config", "vitest.config.ts", COST_PROXY_SPEC, "-t", "G77 cost proxy A01 pause sample"],
    cwd,
    label,
  );
}

function preparePinnedCheckout() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "g77-cost-pinned-"));
  const checkout = git(["worktree", "add", "--detach", tempRoot, PINNED_MAIN], root);
  if ((checkout.status ?? 1) !== 0) {
    throw new Error(`failed to add pinned-main worktree: ${checkout.stderr || checkout.stdout}`);
  }
  const install = spawnSync("npm", ["install"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: envWithPath,
    stdio: "pipe",
  });
  if ((install.status ?? 1) !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    git(["worktree", "remove", "--force", tempRoot], root);
    throw new Error(`pinned-main install failed: ${install.stderr || install.stdout}`);
  }
  const proxySource = path.join(root, COST_PROXY_SPEC);
  if (!existsSync(proxySource)) {
    throw new Error(`missing portable cost proxy spec at ${proxySource}`);
  }
  copyFileSync(proxySource, path.join(tempRoot, COST_PROXY_SPEC));
  const build = spawnSync(
    "npm",
    ["run", "build", "--workspace", "@sekiban/dcb-core", "--workspace", "@sekiban/dcb-domain", "--workspace", "@sekiban/dcb-runtime"],
    { cwd: tempRoot, encoding: "utf8", env: envWithPath },
  );
  if ((build.status ?? 1) !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    git(["worktree", "remove", "--force", tempRoot], root);
    throw new Error(`pinned-main build failed: ${build.stderr || build.stdout}`);
  }
  const bundle = spawnSync(
    "npx",
    [
      "esbuild",
      "packages/dcb-runtime/src/cloudflare.ts",
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--external:cloudflare:workers",
      "--outfile=packages/dcb-runtime/dist/cloudflare.js",
    ],
    { cwd: tempRoot, encoding: "utf8", env: envWithPath },
  );
  if ((bundle.status ?? 1) !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    git(["worktree", "remove", "--force", tempRoot], root);
    throw new Error(`pinned-main runtime bundle failed: ${bundle.stderr || bundle.stdout}`);
  }
  return tempRoot;
}

function assertRunSucceeded(run) {
  if (run.exitCode !== 0) {
    throw new Error(`${run.label} failed (exit ${run.exitCode}): ${run.stderr || run.stdout}`);
  }
}

const implHead = git(["rev-parse", "HEAD"]).stdout.trim();
const pinnedRoot = preparePinnedCheckout();

try {
  const warmPinned = runVitest(pinnedRoot, "warm-pinned-main", COST_PROXY_SPEC);
  const warmImpl = runVitest(root, "warm-implementation", COST_PROXY_SPEC);
  const restartedPinned = runVitest(pinnedRoot, "restarted-pinned-main", COST_PROXY_SPEC);
  const restartedImpl = runVitest(root, "restarted-implementation", COST_PROXY_SPEC);
  const pinnedCommitSamples = Array.from({ length: COMMIT_SAMPLES }, (_, index) =>
    runCommitSample(pinnedRoot, `pinned-commit-sample-${index + 1}`));
  const implCommitSamples = Array.from({ length: COMMIT_SAMPLES }, (_, index) =>
    runCommitSample(root, `impl-commit-sample-${index + 1}`));

  for (const run of [warmPinned, warmImpl, restartedPinned, restartedImpl, ...pinnedCommitSamples, ...implCommitSamples]) {
    assertRunSucceeded(run);
  }

  const pinnedCommitP95 = percentile(pinnedCommitSamples.map((sample) => sample.wallMs), 0.95);
  const implCommitP95 = percentile(implCommitSamples.map((sample) => sample.wallMs), 0.95);

  const report = {
    pinnedMain: PINNED_MAIN,
    implementationHead: implHead,
    predeclaredBars: { safePassWallRatio: SAFE_PASS_BAR, commitP95Ratio: COMMIT_P95_BAR },
    workload: {
      spec: COST_PROXY_SPEC,
      pinnedSide: "portable proxy copied from implementation; G77 routes absent at pin",
      implementationSide: "same proxy with G77 inventory/reconcile when routes exist",
      backlogAttempts: 40,
    },
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
    note: "Both sides execute the portable cost proxy in independent worktrees/processes; pinned main lacks G77 routes so inventory/reconcile branches are skipped there.",
  };

  console.log(JSON.stringify(report, null, 2));
  const exceeded = Object.values(report.decisions).some((decision) => decision === false);
  process.exit(exceeded ? 2 : 0);
} finally {
  rmSync(pinnedRoot, { recursive: true, force: true });
  git(["worktree", "remove", "--force", pinnedRoot], root);
}

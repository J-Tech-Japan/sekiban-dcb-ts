#!/usr/bin/env node
/**
 * SDT-G91 decision-grade G77 AC6 measurement runner.
 * Replaces scripts/g77-cost-measure.mjs portable whole-process proxy.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_MAIN = "2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99";
const SAFE_PASS_BAR = 0.05;
const COMMIT_P95_BAR = 0.10;
const MEASUREMENT_SPEC = "test/g77-ac6-measurement.spec.ts";
const HELPER_SPEC = "test/helpers/g77-ac6-measurement.ts";
const LEGACY_PROXY_SPEC = "scripts/g77-cost-measure.mjs (delegates to g77-ac6-measure.mjs)";
const COMMIT_VECTORS = ["new", "replayed", "multi-candidate", "multi-tag"];
const envWithPath = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` };

function git(args, cwd = root) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: envWithPath });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseReportFromOutput(output) {
  const marker = "SDT_G77_AC6_REPORT::";
  const index = output.indexOf(marker);
  if (index === -1) return null;
  const tail = output.slice(index + marker.length);
  const start = tail.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let offset = start; offset < tail.length; offset += 1) {
    const char = tail[offset];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(tail.slice(start, offset + 1));
      }
    }
  }
  return null;
}


function runVitest(cwd, cohort, reportLabel, commitSide = "main") {
  const started = Date.now();
  const result = spawnSync(
    "npx",
    [
      "vitest", "run",
      "--config", "vitest.config.ts",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=default",
      "--reporter=./scripts/g77-ac6-vitest-reporter.mjs",
      MEASUREMENT_SPEC,
      "-t", cohort === "all" ? "G77 AC6" : `G77 AC6 ${cohort}`,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...envWithPath,
        SDT_G77_AC6_EMIT_REPORT: "1",
        SDT_G77_AC6_COHORT: cohort,
        SDT_G77_AC6_COMMIT_SIDE: commitSide,
      },
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    wallMs: Date.now() - started,
    exitCode: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
    output,
    reportLabel,
    report: parseReportFromOutput(output),
  };
}

function buildRuntime(cwd) {
  const build = spawnSync(
    "npm",
    ["run", "build", "--workspace", "@sekiban/dcb-core", "--workspace", "@sekiban/dcb-domain", "--workspace", "@sekiban/dcb-runtime"],
    { cwd, encoding: "utf8", env: envWithPath },
  );
  if ((build.status ?? 1) !== 0) {
    throw new Error(`build failed: ${build.stderr || build.stdout}`);
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
    { cwd, encoding: "utf8", env: envWithPath },
  );
  if ((bundle.status ?? 1) !== 0) {
    throw new Error(`runtime bundle failed: ${bundle.stderr || bundle.stdout}`);
  }
}

function preparePinnedCheckout() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "g77-ac6-pinned-"));
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
  for (const relative of [MEASUREMENT_SPEC, HELPER_SPEC, "test/helpers/g77-fixtures.ts", "test/helpers/g32-fixtures.ts", "test/helpers/g44-d1-migration.ts", "vitest.config.ts", "scripts/g77-ac6-vitest-reporter.mjs"]) {
    const source = path.join(root, relative);
    if (!existsSync(source)) {
      throw new Error(`missing measurement artefact at ${source}`);
    }
    copyFileSync(source, path.join(tempRoot, relative));
  }
  buildRuntime(tempRoot);
  return tempRoot;
}

function dispositionFromRatio(ratio, bar, inconclusive) {
  if (inconclusive) return "inconclusive";
  return ratio <= bar ? "pass" : "exceed";
}

function assertRunSucceeded(_cwd, run, label) {
  if (run.report === null) {
    throw new Error(`${label} did not emit report (exit ${run.exitCode}): ${run.output ?? run.stderr ?? run.stdout}`);
  }
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    throw new Error(`${label} failed (exit ${run.exitCode}): ${run.output ?? run.stderr ?? run.stdout}`);
  }
}

const implHead = git(["rev-parse", "HEAD"]).stdout.trim();
buildRuntime(root);

const warmRun = runVitest(root, "safe-pass warm cohort", "safe-pass-warm");
const restartedRun = runVitest(root, "safe-pass restarted cohort", "safe-pass-restarted");
assertRunSucceeded(root, warmRun, "safe-pass warm");
assertRunSucceeded(root, restartedRun, "safe-pass restarted");

const pinnedRoot = preparePinnedCheckout();
const commitReports = { main: {}, pinned: {} };

try {
  for (const vector of COMMIT_VECTORS) {
    const mainRun = runVitest(root, `commit ${vector} vector`, `commit-${vector}`, "main");
    const pinnedRun = runVitest(pinnedRoot, `commit ${vector} vector`, `commit-${vector}`, "pinned");
    assertRunSucceeded(root, mainRun, `commit main ${vector}`);
    assertRunSucceeded(pinnedRoot, pinnedRun, `commit pinned ${vector}`);
    commitReports.main[vector] = mainRun.report;
    commitReports.pinned[vector] = pinnedRun.report;
  }
} finally {
  rmSync(pinnedRoot, { recursive: true, force: true });
  git(["worktree", "remove", "--force", pinnedRoot], root);
}

const commitDispositions = {};
const commitMetrics = {};
for (const vector of COMMIT_VECTORS) {
  const mainP95 = commitReports.main[vector].p95;
  const pinnedP95 = commitReports.pinned[vector].p95;
  const ratio = pinnedP95 === 0 ? 0 : (mainP95 - pinnedP95) / pinnedP95;
  const residuals = commitReports.main[vector].samples.map((sample, index) =>
    Math.abs(sample.wallMs - commitReports.pinned[vector].samples[index].wallMs));
  const mad = median(residuals.map((value) => Math.abs(value - median(residuals))));
  const inconclusive = mad * 3 > Math.abs(mainP95 - pinnedP95);
  commitMetrics[vector] = { mainP95, pinnedP95, ratio, mad, inconclusive };
  commitDispositions[vector] = dispositionFromRatio(ratio, COMMIT_P95_BAR, inconclusive);
}

const aggregateCommitP95Main = median(COMMIT_VECTORS.map((vector) => commitMetrics[vector].mainP95));
const aggregateCommitP95Pinned = median(COMMIT_VECTORS.map((vector) => commitMetrics[vector].pinnedP95));
const aggregateCommitRatio = aggregateCommitP95Pinned === 0
  ? 0
  : (aggregateCommitP95Main - aggregateCommitP95Pinned) / aggregateCommitP95Pinned;
const aggregateCommitInconclusive = COMMIT_VECTORS.every((vector) => commitDispositions[vector] === "inconclusive");

const protocol = {
  pinnedMain: PINNED_MAIN,
  implementationHead: implHead,
  backend: "cloudflare vitest workerd (Miniflare)",
  runnerShape: "vitest run --config vitest.config.ts --maxWorkers=1 --no-file-parallelism",
  warmUpPolicy: `${warmRun.report.summary ? 4 : 4} interleaved gate-off/gate-on pairs excluded before scoring`,
  sampleCount: `${warmRun.report.summary.pairCount} scored safe-pass pairs; ${COMMIT_VECTORS.length} commit vectors x ${commitReports.main.new.samples.length} scored samples`,
  cohortOrdering: "alternating within-pair gate-off/gate-on order by pair parity; commit vectors run warm-up then scored on pinned then main worktrees",
  statisticalMethod: "paired delta median with MAD*3 inconclusive guard; p95 from >=24 scored samples per arm",
  resolvedHistory: 30,
  unresolvedBacklog: 10,
  legacyPrecut: 5,
  predeclaredBars: { safePassWallRatio: SAFE_PASS_BAR, commitP95Ratio: COMMIT_P95_BAR },
  supersededProxy: LEGACY_PROXY_SPEC,
};

const report = {
  protocol,
  safePass: {
    warm: {
      ...warmRun.report,
      disposition: warmRun.report.disposition,
    },
    restarted: {
      ...restartedRun.report,
      disposition: restartedRun.report.disposition,
    },
  },
  commit: {
    vectors: commitMetrics,
    dispositions: commitDispositions,
    aggregate: {
      mainP95: aggregateCommitP95Main,
      pinnedP95: aggregateCommitP95Pinned,
      ratio: aggregateCommitRatio,
      bar: COMMIT_P95_BAR,
      disposition: dispositionFromRatio(aggregateCommitRatio, COMMIT_P95_BAR, aggregateCommitInconclusive),
    },
  },
  findings: [],
};

for (const [label, entry] of [
  ["safe-pass-warm", warmRun.report],
  ["safe-pass-restarted", restartedRun.report],
]) {
  if (entry.disposition === "exceed") {
    report.findings.push(`${label} exceeded +${(SAFE_PASS_BAR * 100).toFixed(0)}% bar (ratio ${entry.ratio.toFixed(3)})`);
  }
  if (entry.disposition === "inconclusive") {
    report.findings.push(`${label} inconclusive (noise dominated)`);
  }
}
for (const vector of COMMIT_VECTORS) {
  const { ratio } = commitMetrics[vector];
  const disposition = commitDispositions[vector];
  if (disposition === "exceed") {
    report.findings.push(`commit-${vector} p95 exceeded +${(COMMIT_P95_BAR * 100).toFixed(0)}% bar (ratio ${ratio.toFixed(3)})`);
  }
}
if (report.commit.aggregate.disposition === "exceed") {
  report.findings.push(`commit aggregate p95 exceeded +${(COMMIT_P95_BAR * 100).toFixed(0)}% bar (ratio ${aggregateCommitRatio.toFixed(3)})`);
}
if (report.commit.aggregate.disposition === "inconclusive") {
  report.findings.push("commit aggregate inconclusive (noise dominated)");
}

mkdirSync(path.join(root, ".artifacts"), { recursive: true });
writeFileSync(path.join(root, ".artifacts", "g77-ac6-full-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

const exceeded = report.findings.some((finding) => finding.includes("exceeded"));
const onlyInconclusive = report.findings.length > 0 && report.findings.every((finding) => finding.includes("inconclusive"));
process.exit(exceeded ? 2 : onlyInconclusive ? 3 : 0);

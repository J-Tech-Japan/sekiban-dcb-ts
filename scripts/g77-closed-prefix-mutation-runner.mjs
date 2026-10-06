#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("g77-closed-prefix-mutation-runner: vitest executable is unavailable");

const files = {
  allocator: join(root, "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts"),
  ledger: join(root, "packages/dcb-runtime/src/allocator/IssuanceLedger.ts"),
  reconciler: join(root, "packages/dcb-runtime/src/allocator/IssuanceReconciler.ts"),
  fixtures: join(root, "test/helpers/g77-fixtures.ts"),
};
const sources = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readFileSync(file, "utf8")]));

const mutants = [
  {
    name: "registration-removed",
    file: "allocator",
    from: "await registerIssuanceInTransaction(txn, {",
    to: "void ({ // mutant: registration removed",
    expectedTests: ["G77 registers issuance ledger facts atomically when membership is supplied"],
    unrelatedTests: ["G77 predecessor lookup stays correct beyond 256 issuances"],
  },
  {
    name: "single-tag-resolved-early",
    file: "ledger",
    from: "if (!resolved) return { candidateResolved: false, duplicate: false };",
    to: "if (!resolved) return { candidateResolved: true, duplicate: false };",
    expectedTests: ["G77 mutant oracle: multi-tag candidate stays unresolved until every target terminal"],
    unrelatedTests: ["G77 inspection failure does not force-tombstone pending targets"],
  },
  {
    name: "expired-writer-accepted",
    file: "reconciler",
    from: "evidence.pinnedWriterEpoch !== envelope.pinnedWriterEpoch",
    to: "evidence.pinnedWriterEpoch !== envelope.pinnedWriterEpoch && false",
    expectedTests: ["G77 rejects resolution with mismatched pinned writer epoch"],
    unrelatedTests: ["G77 fenced absence resolves a pending target without accepting expiry alone"],
  },
  {
    name: "wrong-prefix-watermark",
    file: "ledger",
    from: "return { closedPrefixSuid, unresolvedCount: count, status: \"ready\" };",
    to: "return { closedPrefixSuid: allocatedWatermark, unresolvedCount: count, status: \"ready\" };",
    expectedTests: [
      "G77 predecessor prefix excludes the least unresolved hole",
      "G77 positive predecessor oracle with multi-candidate hole",
    ],
    unrelatedTests: ["G77 predecessor lookup stays correct beyond 256 issuances"],
  },
  {
    name: "highest-completed-prefix",
    file: "ledger",
    from: `  const endKey = \`\${ISSUED_INDEX_PREFIX}\${exclusiveSuid}:\`;
  const listed = await reader.list<{ suid: string }>({
    prefix: ISSUED_INDEX_PREFIX,
    end: endKey,
    reverse: true,
    limit: 1,
  });
  for (const [key, value] of listed) {
    const suid = value?.suid ?? parseIndexEntry(key, ISSUED_INDEX_PREFIX)?.suid;
    if (suid !== undefined && suid < exclusiveSuid) return suid;
  }
  return null;`,
    to: `  const listed = await reader.list<{ suid: string }>({ prefix: ISSUED_INDEX_PREFIX, limit: 256 });
  let best: string | null = null;
  for (const [key, value] of listed) {
    const suid = value?.suid ?? parseIndexEntry(key, ISSUED_INDEX_PREFIX)?.suid;
    if (suid === undefined || suid >= exclusiveSuid) continue;
    if (best === null || suid > best) best = suid;
  }
  return best;`,
    expectedTests: [
      "G77 predecessor lookup stays correct beyond 256 issuances",
    ],
    unrelatedTests: ["G77 predecessor prefix excludes the least unresolved hole"],
  },
  {
    name: "omitted-issuance-write",
    file: "fixtures",
    from: "const envelope = await state.storage.get(`issuance:envelope:${attemptId}:${candidateIndex}`);",
    to: "const envelope = undefined;",
    expectedTests: ["G77 current commit path writes the issuance envelope"],
    unrelatedTests: ["G77 current seed preserves resolved history depth"],
  },
  {
    name: "hidden-history-scan",
    file: "fixtures",
    from: "for (let index = 0; index < G77_AC6_RESOLVED_HISTORY; index += 1) {",
    to: "for (let index = 0; index < 0; index += 1) {",
    expectedTests: ["G77 current seed preserves resolved history depth"],
    unrelatedTests: ["G77 current commit path writes the issuance envelope"],
  },
  {
    name: "reduced-backlog",
    file: "fixtures",
    from: "for (let index = 0; index < G77_AC6_UNRESOLVED_BACKLOG; index += 1) {",
    to: "for (let index = 0; index < 0; index += 1) {",
    expectedTests: ["G77 current seed preserves unresolved backlog floor"],
    unrelatedTests: ["G77 current commit path writes the issuance envelope"],
  },
];

function restore() {
  for (const [key, file] of Object.entries(files)) {
    writeFileSync(file, sources[key], "utf8");
  }
}

function runBuild() {
  const result = spawnSync("npm", ["run", "build", "--workspace", "@sekiban/dcb-runtime", "--silent"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function failingTestNames(report) {
  return assertionNames(report, "failed");
}

function passingTestNames(report) {
  return assertionNames(report, "passed");
}

function assertionNames(report, status) {
  if (!Array.isArray(report?.testResults)) return [];
  return report.testResults.flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((assertion) => assertion.status === status)
      .map((assertion) => assertion.fullName ?? assertion.title ?? ""),
  );
}

if (process.argv.includes("--self-test")) {
  for (const mutant of mutants) {
    if (!sources[mutant.file].includes(mutant.from)) {
      console.error(`self-test failed: anchor missing for ${mutant.name}`);
      process.exit(1);
    }
  }
  console.log("g77-closed-prefix-mutation-runner self-test ok");
  process.exit(0);
}

const reportDirectory = mkdtempSync(join(tmpdir(), "sdt-g77-mutation-"));
let reportCounter = 0;

function runOracle(mutant) {
  const reportPath = join(reportDirectory, `${++reportCounter}-${mutant.name}.json`);
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "test/allocator.spec.ts",
    "test/g77-closed-prefix-producer.spec.ts",
    "-t",
    "G77|A04|B07|multi-tag|predecessor",
    "--reporter=json",
    "--outputFile",
    reportPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = undefined;
  }
  return { status: result.status ?? 1, report, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const results = [];
try {
  for (const mutant of mutants) {
    const file = files[mutant.file];
    const original = sources[mutant.file];
    if (!original.includes(mutant.from)) {
      results.push({ mutant: mutant.name, status: "skipped", reason: "anchor not found" });
      continue;
    }
    writeFileSync(file, original.replace(mutant.from, mutant.to), "utf8");
    const build = runBuild();
    if (!build.ok) {
      restore();
      results.push({
        mutant: mutant.name,
        status: "build-break",
        buildStatus: build.status,
      });
      continue;
    }
    const run = runOracle(mutant);
    restore();
    runBuild();
    const failures = failingTestNames(run.report);
    const passes = passingTestNames(run.report);
    const matched = mutant.expectedTests.filter((name) =>
      failures.some((failure) => failure.includes(name)),
    );
    const missingTargets = mutant.expectedTests.filter((name) =>
      !failures.some((failure) => failure.includes(name)),
    );
    const unrelatedFailures = (mutant.unrelatedTests ?? []).filter((name) =>
      failures.some((failure) => failure.includes(name)),
    );
    const missingUnrelated = (mutant.unrelatedTests ?? []).filter((name) =>
      !passes.some((pass) => pass.includes(name)),
    );
    results.push({
      mutant: mutant.name,
      status:
        run.status === 0
          ? "unexpected-green"
          : missingTargets.length === 0 && unrelatedFailures.length === 0 && missingUnrelated.length === 0
            ? "red"
            : "unexpected-red",
      exitCode: run.status,
      failingTests: failures,
      passingTests: passes,
      matchedTests: matched,
      missingTargets,
      unrelatedFailures,
      missingUnrelated,
    });
  }
} finally {
  restore();
  runBuild();
  rmSync(reportDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({ mutants: results }, null, 2));
const unexpected = results.filter((entry) =>
  entry.status === "unexpected-green" || entry.status === "unexpected-red" || entry.status === "build-break",
);
process.exit(unexpected.length === 0 ? 0 : 1);

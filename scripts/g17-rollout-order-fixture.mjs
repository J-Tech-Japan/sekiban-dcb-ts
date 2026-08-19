import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scratch = mkdtempSync(join(tmpdir(), "sdt-g17-rollout-order-"));
const psql = join(scratch, "psql");
writeFileSync(
  psql,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const commandIndex = args.indexOf("-c");
const sql = commandIndex >= 0 ? args[commandIndex + 1] ?? "" : "";
if (/SELECT\\s+count\\(\\*\\)/i.test(sql)) process.stdout.write("0\\n");
`,
  { mode: 0o755 },
);
chmodSync(psql, 0o755);

const script = resolve(process.cwd(), "scripts/g17-staged-rollout.sh");
const target = "fixture-g17-service";
const baseEnv = {
  ...process.env,
  PATH: `${scratch}:${process.env.PATH ?? ""}`,
  POSTGRES_URL: "fixture://postgres",
  G17_TARGET_SERVICE_ID: target,
};

function run(phase, stateFile, extra = {}) {
  return spawnSync("bash", [script, phase], {
    cwd: process.cwd(),
    env: { ...baseEnv, G17_ROLLOUT_STATE_FILE: stateFile, ...extra },
    encoding: "utf8",
  });
}

function assertFails(label, result) {
  if (result.status === 0) {
    throw new Error(`${label} unexpectedly succeeded (rollout ordering guard is not load-bearing)`);
  }
}

const missingState = join(scratch, "missing.json");
assertFails("constraint without dry-run state", run("constraint", missingState));

const cleanupNotRecorded = join(scratch, "cleanup-not-recorded.json");
writeFileSync(cleanupNotRecorded, JSON.stringify({
  targetServiceId: target,
  duplicatePairs: 1,
  duplicateRowsToQuarantine: 1,
  cleanupRecorded: false,
  constraintDeployed: false,
}));
assertFails("constraint with cleanupRecorded=false", run("constraint", cleanupNotRecorded));

const beforeConstraint = join(scratch, "before-constraint.json");
writeFileSync(beforeConstraint, JSON.stringify({
  targetServiceId: target,
  duplicatePairs: 0,
  duplicateRowsToQuarantine: 0,
  cleanupRecorded: true,
  constraintDeployed: false,
}));
assertFails("resume before constraint", run("resume", beforeConstraint));

const happyState = join(scratch, "happy.json");
for (const phase of ["dry-run", "cleanup", "constraint", "resume"]) {
  const result = run(phase, happyState, phase === "cleanup" ? { G17_CLEANUP_CONFIRM: "YES" } : {});
  if (result.status !== 0) {
    throw new Error(`${phase} happy path failed with ${result.status}: ${result.stderr}`);
  }
}

process.stdout.write(`rollout-order fixture passed; scratch=${scratch}\n`);

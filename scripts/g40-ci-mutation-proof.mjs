#!/usr/bin/env node
/**
 * AC3 reachability proof: replace one real PR-lane check in a temporary copy
 * of ci.yml and require the coverage checker to reject that missing leaf.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const workflow = resolve(root, ".github/workflows/ci.yml");
const checker = resolve(root, "scripts/g40-ci-coverage-check.mjs");
const baseline = resolve(root, "docs/evidence/SDT-G40-ci-step-inventory-baseline.json");
const target = "run: npm run test:g37:evidence";

function fail(message) {
  throw new Error(`g40-ci-mutation-proof:${message}`);
}

const temporary = mkdtempSync(resolve(tmpdir(), "sdt-g40-ci-mutation-"));
try {
  const original = readFileSync(workflow, "utf8");
  if (!original.includes(target)) fail(`target leaf '${target}' was not found in ci.yml`);
  const mutatedWorkflow = resolve(temporary, "ci.yml");
  // This removes the G37 evidence leaf while preserving valid YAML and a
  // distinct existing command.  The checker must reject the missing command.
  writeFileSync(mutatedWorkflow, original.replace(target, "run: npm run lint"));
  const result = spawnSync(process.execPath, [checker, "--baseline", baseline, "--workflow", mutatedWorkflow], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) fail("coverage checker unexpectedly accepted the deleted G37 evidence leaf");
  process.stdout.write(`${JSON.stringify({
    schema: "sdt-g40-ci-mutation-proof/v1",
    mutation: "replace npm run test:g37:evidence with npm run lint",
    checkerExitStatus: result.status,
    checkerRejectedMissingLeaf: true,
  }, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

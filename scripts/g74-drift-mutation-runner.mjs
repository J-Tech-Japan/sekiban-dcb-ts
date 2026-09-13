#!/usr/bin/env node
/** Named SDT-G74 drift and export-addition red-proof entry point. */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = resolve(root, "scripts/g74-surface-guard.mjs");
const required = new Set([
  "removed-export",
  "renamed-export",
  "parameter-type-change",
  "return-type-change",
  "type-widening",
  "type-narrowing",
  "public-root-export-addition",
  "unclassified-executor-export",
]);

const result = spawnSync(process.execPath, [guard, "--self-test"], { cwd: root, encoding: "utf8", env: process.env });
if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
let receipt;
try {
  receipt = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`SDT-G74 mutation runner: guard did not emit JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
}
const labels = new Set((receipt.mutations ?? []).map((mutation) => mutation.label));
for (const label of required) {
  if (!labels.has(label)) throw new Error(`SDT-G74 mutation runner: missing red proof ${label}`);
  const mutation = receipt.mutations.find((candidate) => candidate.label === label);
  if (mutation.result !== "RED_DETECTED") throw new Error(`SDT-G74 mutation runner: ${label} was not red`);
}
process.stdout.write(`${JSON.stringify({
  schema: "sdt-g74-drift-mutation/v1",
  status: "PASS",
  redMutants: [...required],
  guardReceipt: receipt,
}, null, 2)}\n`);

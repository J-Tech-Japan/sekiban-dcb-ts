#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selectionPath = resolve(root, "scripts/g72-trusted-publishing-selection.mjs");
const guardPath = resolve(root, "scripts/g72-trusted-publishing-guard.mjs");
const source = readFileSync(selectionPath, "utf8");

const mutations = [
  {
    id: "no-auth-publishes",
    needle: '  return AUTH_MODES.DRY_RUN;\n',
    replacement: '  return AUTH_MODES.TOKEN;\n',
  },
  {
    id: "ignore-true-trusted-publishing",
    needle: '  if (trustedPublishing === true || trustedPublishing === "true") {',
    replacement: '  if (false && (trustedPublishing === true || trustedPublishing === "true")) {',
  },
  {
    id: "ignore-available-token",
    needle: '  if (tokenConfigured === true || tokenConfigured === "true") {',
    replacement: '  if (false && (tokenConfigured === true || tokenConfigured === "true")) {',
  },
  {
    id: "hard-code-public-provenance",
    needle: '  if (repositoryPrivate === true) {',
    replacement: '  if (true) {',
  },
];

function runGuard() {
  return spawnSync(process.execPath, [guardPath], {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
  });
}

function selfTest() {
  for (const mutation of mutations) {
    assert.equal(
      source.split(mutation.needle).length - 1,
      1,
      `${mutation.id} must have exactly one product-source target`,
    );
  }
  console.log(JSON.stringify({ guard: "sdt-g72-trusted-publishing-mutation-runner", status: "SELF_TEST_PASS", mutants: mutations.map(({ id }) => id) }, null, 2));
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const red = [];
  try {
    for (const mutation of mutations) {
      const mutated = source.replace(mutation.needle, mutation.replacement);
      writeFileSync(selectionPath, mutated);
      const result = runGuard();
      assert.notEqual(
        result.status,
        0,
        `${mutation.id} unexpectedly survived\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      red.push({ id: mutation.id, status: result.status, result: "red" });
    }
  } finally {
    writeFileSync(selectionPath, source);
  }

  console.log(JSON.stringify({
    guard: "sdt-g72-trusted-publishing-mutation-runner",
    status: "PASS",
    mutants: red,
    result: "all-product-mutants-red",
  }, null, 2));
}

main();

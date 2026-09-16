#!/usr/bin/env node
/**
 * SDT-G93 static guard: workflow Action major census and canonical repository.url.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = resolve(root, ".github/workflows");
const canonicalRepositoryUrl = "git+https://github.com/J-Tech-Japan/sekiban-dcb-ts.git";
const publicPackages = ["dcb-core", "dcb-domain", "dcb-client"];

const expectedV5Counts = {
  "actions/checkout@v5": 7,
  "actions/setup-node@v5": 7,
  "actions/cache@v5": 2,
  "actions/setup-dotnet@v5": 1,
};

const forbiddenV4 = [
  "actions/checkout@v4",
  "actions/setup-node@v4",
  "actions/cache@v4",
  "actions/setup-dotnet@v4",
];

/** Recorded upstream action metadata (runs.using) for AC2. */
const node24ActionContract = {
  "actions/checkout@v5": "node24",
  "actions/setup-node@v5": "node24",
  "actions/cache@v5": "node24",
  "actions/setup-dotnet@v5": "node24",
};

async function assertWorkflowCensus() {
  const files = (await readdir(workflowDir)).filter((name) => name.endsWith(".yml")).sort();
  assert.equal(files.length, 5, "expected exactly five workflow files");
  const combined = (await Promise.all(files.map((name) => readFile(resolve(workflowDir, name), "utf8")))).join("\n");

  for (const forbidden of forbiddenV4) {
    assert.equal(combined.includes(forbidden), false, `forbidden workflow pin remains: ${forbidden}`);
  }

  const counts = {};
  for (const action of Object.keys(expectedV5Counts)) {
    counts[action] = combined.split(action).length - 1;
    assert.equal(counts[action], expectedV5Counts[action], `${action} call-site count`);
  }

  return { workflowFiles: files, counts, node24ActionContract };
}

async function assertRepositoryUrls() {
  const packages = {};
  for (const name of publicPackages) {
    const manifest = JSON.parse(await readFile(resolve(root, "packages", name, "package.json"), "utf8"));
    assert.equal(manifest.repository?.url, canonicalRepositoryUrl, `${name} repository.url`);
    packages[name] = manifest.repository.url;
  }
  return { packages, canonicalRepositoryUrl };
}

const workflow = await assertWorkflowCensus();
const packages = await assertRepositoryUrls();

console.log(JSON.stringify({
  status: "PASS",
  guard: "sdt-g93-workflow-package",
  workflow,
  packages,
}, null, 2));

#!/usr/bin/env node
/**
 * SDT-G99: meeting-room must declare registry semver for the matched-set
 * packages (no file:/workspace: deps). Fail-closed cheap guard.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sampleManifestPath = resolve(root, "samples/meeting-room/package.json");
const requiredPackages = Object.freeze([
  "@sekiban/dcb-core",
  "@sekiban/dcb-domain",
  "@sekiban/dcb-client",
  "@sekiban/dcb-runtime",
]);
const expectedVersion = "0.2.0";

function assertRegistrySemver(dependencies, label) {
  assert.equal(dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies), false, `${label} dependencies must be an object`);
  for (const name of requiredPackages) {
    const value = dependencies[name];
    assert.equal(typeof value, "string", `${label} missing dependency ${name}`);
    assert.equal(value.includes("file:"), false, `${label} ${name} must not use file:`);
    assert.equal(value.includes("workspace:"), false, `${label} ${name} must not use workspace:`);
    assert.equal(value, expectedVersion, `${label} ${name} must be registry semver ${expectedVersion}`);
  }
}

function evaluateManifest(manifest, label = "samples/meeting-room/package.json") {
  assert.equal(manifest?.name, "@sekiban/meeting-room-sample", `${label} name drifted`);
  assertRegistrySemver(manifest.dependencies, label);
  return Object.freeze({
    name: manifest.name,
    dependencies: Object.fromEntries(requiredPackages.map((name) => [name, manifest.dependencies[name]])),
  });
}

function selfTest() {
  const baseline = {
    name: "@sekiban/meeting-room-sample",
    dependencies: {
      "@sekiban/dcb-client": "0.2.0",
      "@sekiban/dcb-core": "0.2.0",
      "@sekiban/dcb-domain": "0.2.0",
      "@sekiban/dcb-runtime": "0.2.0",
    },
  };
  evaluateManifest(baseline, "self-test baseline");

  const mutants = [
    ["file dep", { ...baseline, dependencies: { ...baseline.dependencies, "@sekiban/dcb-runtime": "file:../../packages/dcb-runtime" } }],
    ["workspace dep", { ...baseline, dependencies: { ...baseline.dependencies, "@sekiban/dcb-core": "workspace:*" } }],
    ["wrong version", { ...baseline, dependencies: { ...baseline.dependencies, "@sekiban/dcb-client": "0.1.0" } }],
    ["missing runtime", { ...baseline, dependencies: { "@sekiban/dcb-client": "0.2.0", "@sekiban/dcb-core": "0.2.0", "@sekiban/dcb-domain": "0.2.0" } }],
  ];
  for (const [label, mutant] of mutants) {
    let failed = false;
    try {
      evaluateManifest(mutant, `self-test ${label}`);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, `self-test mutant must fail: ${label}`);
  }
  return { status: "PASS", guard: "sdt-g99-sample-registry", selfTest: true };
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify(selfTest(), null, 2)}\n`);
} else {
  const manifest = JSON.parse(await readFile(sampleManifestPath, "utf8"));
  const checked = evaluateManifest(manifest);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    guard: "sdt-g99-sample-registry",
    path: "samples/meeting-room/package.json",
    checked,
  }, null, 2)}\n`);
}

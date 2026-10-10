#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = Object.freeze({
  core: "dcb-core",
  domain: "dcb-domain",
  client: "dcb-client",
  runtime: "dcb-runtime",
});

async function readInputs() {
  const manifests = {};
  for (const [key, directory] of Object.entries(packageDirectories)) {
    manifests[key] = JSON.parse(await readFile(resolve(root, "packages", directory, "package.json"), "utf8"));
  }
  return {
    manifests,
    lockfile: JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")),
    changelog: await readFile(resolve(root, "CHANGELOG.md"), "utf8"),
  };
}

function fail(message) {
  throw new Error(`SDT-G64 release guard: ${message}`);
}

function bumpPatch(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return `${version}-mutant`;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function validateRelease({ manifests, lockfile, changelog, tag = "" }) {
  const version = manifests.core?.version;
  if (typeof version !== "string" || version.length === 0) fail("core manifest has no version");

  for (const [key, manifest] of Object.entries(manifests)) {
    if (manifest.version !== version) {
      fail(`${key} is ${manifest.version}, expected the core manifest version ${version}`);
    }
    if (manifest.private !== false) fail(`${key} is private`);
  }

  if (manifests.client.dependencies?.["@sekiban/dcb-core"] !== version) {
    fail(`client core pin is not the matched version ${version}`);
  }
  if (manifests.client.dependencies?.["@sekiban/dcb-domain"] !== version) {
    fail(`client domain pin is not the matched version ${version}`);
  }
  if (manifests.runtime.dependencies?.["@sekiban/dcb-core"] !== version) {
    fail(`runtime core pin is not the matched version ${version}`);
  }

  if (tag !== "") {
    const match = /^dcb-v(.+)$/.exec(tag);
    if (!match || match[1] !== version) fail(`tag ${tag} does not match dcb-v${version}`);
  }

  for (const [key, directory] of Object.entries(packageDirectories)) {
    const lockEntry = lockfile.packages?.[`packages/${directory}`];
    if (!lockEntry) fail(`package-lock is missing the workspace record for ${directory}`);
    if (lockEntry.version !== manifests[key].version) {
      fail(
        `package-lock workspace version for ${directory} is ${lockEntry.version}, expected ${manifests[key].version}`,
      );
    }
    const expectedDependencies = manifests[key].dependencies ?? {};
    if (JSON.stringify(lockEntry.dependencies ?? {}) !== JSON.stringify(expectedDependencies)) {
      fail(`package-lock dependencies for ${directory} are stale`);
    }
  }

  const marker = `## @sekiban/dcb-domain ${version}`;
  if (!changelog.startsWith("# Changelog\n\n") || !changelog.split("\n").some((line) => line.startsWith(marker))) {
    fail(`CHANGELOG.md is missing the current marker ${marker}`);
  }

  return {
    version,
    tag: tag || null,
    order: Object.values(packageDirectories).map((directory) => `@sekiban/${directory}`),
  };
}

function runSelfTest(inputs) {
  const baseline = validateRelease(inputs);
  const expectFailure = (label, mutate, message) => {
    const copy = structuredClone(inputs);
    mutate(copy);
    assert.throws(() => validateRelease(copy), new RegExp(message), label);
    return label;
  };
  const version = baseline.version;
  const wrongTag = `dcb-v${bumpPatch(version)}`;
  const checks = [
    expectFailure(
      "mismatched matched-set manifest",
      (copy) => { copy.manifests.runtime.version = bumpPatch(version); },
      "runtime is",
    ),
    expectFailure("wrong tag", (copy) => { copy.tag = wrongTag; }, "does not match"),
    expectFailure(
      "loose internal pin",
      (copy) => { copy.manifests.client.dependencies["@sekiban/dcb-core"] = `^${version}`; },
      "client core pin",
    ),
    expectFailure(
      "stale lockfile value",
      (copy) => { copy.lockfile.packages["packages/dcb-runtime"].version = bumpPatch(version); },
      "package-lock workspace version",
    ),
    expectFailure(
      "missing changelog marker",
      (copy) => {
        copy.changelog = copy.changelog.replace(
          `## @sekiban/dcb-domain ${version}`,
          "## historical marker",
        );
      },
      "CHANGELOG.md",
    ),
  ];
  return { status: "PASS", guard: "dcb-matched-set-release", checks };
}

const inputs = await readInputs();
const tag = process.argv[2] ?? "";
if (process.argv.includes("--self-test")) {
  console.log(JSON.stringify(runSelfTest({ ...inputs, tag: `dcb-v${inputs.manifests.core.version}` }), null, 2));
} else {
  console.log(JSON.stringify({ status: "PASS", ...validateRelease({ ...inputs, tag }) }, null, 2));
}

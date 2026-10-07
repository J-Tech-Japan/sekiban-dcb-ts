#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const allowlist = ["dcb-core", "dcb-domain", "dcb-client", "dcb-runtime", "dcb-cloudflare", "create-dcb"];

function classifyPublishFailure(result, { packageName, version } = {}) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/(?:EJSONPARSE|JSON\.parse|invalid\s+(?:package(?:\.json)?|manifest)|package\.json[^\n]*(?:invalid|unexpected|parse)|ENOENT[^\n]*package\.json)/i.test(output)) {
    return { kind: "invalid-packaging", packageName, version };
  }
  if (/(?:cannot publish over|previously published versions|EPUBLISHCONFLICT|version collision)/i.test(output)) {
    return { kind: "version-collision", packageName, version };
  }
  return { kind: "publish-or-environment-failure", packageName, version };
}

function fail(message) {
  throw new Error(`publish-dcb-unpublished:${message}`);
}

export function validatePackages(names) {
  const requested = names.length === 0 ? ["dcb-runtime"] : [...names];
  const seen = new Set();
  for (const name of requested) {
    if (!allowlist.includes(name)) fail(`unknown package directory: ${name}`);
    if (seen.has(name)) fail(`duplicate package directory: ${name}`);
    seen.add(name);
  }
  return allowlist.filter((name) => seen.has(name));
}

export function assertWorkflowInputSafe(text) {
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const runMatch = line.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!runMatch) continue;
    if (/\$\{\{\s*inputs\.packages\s*\}\}/.test(runMatch[2])) fail("publish-dcb-unpublished.yml interpolates inputs.packages inside a run block");
    const indentation = runMatch[1].length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].trim().length > 0 && lines[next].match(/^ */)[0].length <= indentation) break;
      if (/\$\{\{\s*inputs\.packages\s*\}\}/.test(lines[next])) fail("publish-dcb-unpublished.yml interpolates inputs.packages inside a run block");
    }
  }
}

function requestedPackages() {
  return String(process.env.REQUESTED_PACKAGES ?? "").trim().split(/\s+/).filter(Boolean);
}

function manifestFor(name) {
  return JSON.parse(readFileSync(resolve(root, "packages", name, "package.json"), "utf8"));
}

function publishPackages(packages, dryRun) {
  const privateRepository = process.env.REPO_IS_PRIVATE === "true" || process.env.PRIVATE_REPOSITORY === "true";
  const args = [
    "publish",
    ...(dryRun ? ["--dry-run"] : []),
    ...(privateRepository ? [] : ["--provenance"]),
    "--access",
    "public",
  ];
  const env = { ...process.env };
  if (privateRepository) env.NPM_CONFIG_PROVENANCE = "false";
  if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
  if (process.env.UNSET_NODE_AUTH_TOKEN === "true") delete env.NODE_AUTH_TOKEN;
  const receipts = [];
  for (const name of packages) {
    const manifest = manifestFor(name);
    const result = spawnSync("npm", args, {
      cwd: resolve(root, "packages", name),
      env,
      encoding: "utf8",
    });
    const receipt = {
      package: `@sekiban/${name}`,
      cwd: `packages/${name}`,
      version: manifest.version,
      command: ["npm", ...args].join(" "),
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (result.status === 0) {
      receipt.outcome = dryRun ? "dry-run-ok" : "published";
      receipts.push(receipt);
      continue;
    }
    const failure = classifyPublishFailure(result, { packageName: `@sekiban/${name}`, version: manifest.version });
    if (failure.kind === "version-collision" && result.signal == null) {
      receipt.outcome = "version-already-published";
      receipt.failure = failure;
      receipts.push(receipt);
      continue;
    }
    console.error(JSON.stringify({ status: "FAIL", receipt, failure }, null, 2));
    process.exit(result.status ?? 1);
  }
  console.log(JSON.stringify({ status: "PASS", dryRun, privateRepository, receipts }, null, 2));
}

function selfTest() {
  const expectFailure = (action, prefix) => {
    try {
      action();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`publish-dcb-unpublished:${prefix}`)) return;
      throw error;
    }
    fail(`expected failure prefix ${prefix}`);
  };
  expectFailure(() => validatePackages(["dcb-runtime", "evil"]), "unknown package directory: evil");
  expectFailure(() => validatePackages(["../dcb-core"]), "unknown package directory: ../dcb-core");
  expectFailure(() => validatePackages(["dcb-runtime;", "echo"]), "unknown package directory: dcb-runtime;");
  expectFailure(() => validatePackages(["dcb-runtime", "dcb-runtime"]), "duplicate package directory: dcb-runtime");
  if (JSON.stringify(validatePackages([])) !== JSON.stringify(["dcb-runtime"])) fail("empty input did not normalize to dcb-runtime");
  if (JSON.stringify(validatePackages(["create-dcb", "dcb-core"])) !== JSON.stringify(["dcb-core", "create-dcb"])) fail("allowlist ordering changed");
  expectFailure(() => assertWorkflowInputSafe("jobs:\n  x:\n    steps:\n      - run: node x.mjs ${{ inputs.packages }}\n"), "publish-dcb-unpublished.yml interpolates inputs.packages inside a run block");
  assertWorkflowInputSafe(readFileSync(resolve(root, ".github/workflows/publish-dcb-unpublished.yml"), "utf8"));
  console.log(JSON.stringify({ result: "publish-dcb-unpublished-self-test-passed", checks: 7 }));
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  if (process.argv.includes("--validate-only")) {
    const packages = validatePackages(requestedPackages());
    console.log(packages.join(" "));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `packages=${packages.join(" ")}\n`);
    return;
  }
  const dryRun = process.argv.includes("--dry-run");
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const packages = validatePackages(requested);
  publishPackages(packages, dryRun);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

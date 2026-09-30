#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const schema = "sdt-g105-public-tree/v1";

const artifactAllowlist = new Set([
  ".artifacts/sdt-g50-w57-commit-latency.json",
  ".artifacts/sdt-g55-packaging-repair-e2e.json",
  ".artifacts/sdt-g58-w102-safe-proof-cohort.json",
  ".artifacts/sdt-g58-w102-safe-proof-cohort.log",
  ".artifacts/sdt-g58-w103-red-guard.json",
  ".artifacts/sdt-g58-w106-red-baseline.json",
  ".artifacts/sdt-g58-w109-ac5-single.json",
  ".artifacts/sdt-g58-w110-red-guard.json",
  ".artifacts/sdt-g58-w112-paced-cohort.json",
  ".artifacts/sdt-g58-w118-ac2-paced-cohort.json",
  ".artifacts/sdt-g58-w118-ac6-e2e.json",
  ".artifacts/sdt-g58-w119-safe-convergence-diagnosis-guard.json",
  ".artifacts/sdt-g58-w96-red-guard.json",
  ".artifacts/sdt-g58-w99-paced-cohort.json",
  ".artifacts/wrangler.g65-w155-c.jsonc",
]);

const authorityExceptions = new Set([
  "contracts/commit-trace-bundle.json",
  "contracts/g38-packet-contract.json",
  "scripts/g30-ac5-structural-check.mjs",
]);

// These are hashes of the account/resource values scrubbed by SDT-G105. The
// guard never carries the identifiers themselves.
const forbiddenTokenDigests = new Set([
  "318d7ddd62ef377e5b35fd8deb821444120689b301e31e47fe2fb272a5f0000b",
  "7036c93f61846fafd7bfd8f345e362a09e17a0965694a808c04f8bf2017b737d",
  "9822730c2999a682afd49a64dd70cc8014ffaf93e4fe9ef379e432d433f6bf8f",
  "06c3a6da88a09bf01c2e4d6130b57880b4a920bdf3d6fac41d968c983ec36d89",
  "f595955dabe1d23dd6c505629633d17a066e320681ca8dece81bf089493c3b6a",
  "4e298760ad44a9f6009249f43cb86de84715cdf2d17e38da49b3b69e4092f884",
  "cc8313219349f5ab181f0a117bb87d9a79d7d7e1139bfc05d44f48cd7a90ab29",
  "b5f348694a36c5c3aa9475374d6852a3a28d1633ec4e620abd97c255a378186e",
  "f2e6ad21ce72a6f3889114ffa62d53a8d4584c01e47f507b2d05f23686f4d4a8",
  "a21128bcebf472c86fb7eff101da86ab86ef8c8d0b828d8ca8f0cb42918ae9f7",
  "ff8ee99c9eb5383b37cce1a4a939e7d384f231c5facad853477e49fc4727270f",
  "7288bf125a1f49e88b8bfd1c76fa3ab24294845454b968bad94dd4ed28722442",
]);

const fakeResourceValues = new Set([
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000018",
  "00000000-0000-0000-0000-000000000019",
]);

const workersDev = ["workers", ".", "dev"].join("");
const markers = [
  ["tt", "akaoka"].join(""),
  ["tomo", "hisa"].join(""),
  ["jtechs", ".", "com"].join(""),
  ["SekibanDcb", "Ts", "Host"].join(""),
  ["SekibanDcb", "Ts", "Implementation"].join(""),
  ["SekibanAsA", "Service"].join(""),
];
const internalHostPath = ["intents", "/", "sekiban-dcb-ts", "/"].join("");
const hostMarker = ["SekibanDcb", "Ts", "Host"].join("");
const rootNotePattern = /^sdt-.*\.md$/i;
const candidateTokenPatterns = [
  /(?=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))/gi,
  /(?=([0-9a-f]{32}))/gi,
];
const personalPathPattern = new RegExp(`/(?:${["home", "Users"].join("|")})/(?!path\\b)[^/\\s"']+`, "i");
const workerHostPattern = new RegExp(`\\b(?:[a-z0-9-]+\\.)+${workersDev.replace(".", "\\.")}\\b`, "gi");

function fail(kind, message) {
  const error = new Error(`public-tree:${kind}:${message}`);
  error.kind = kind;
  throw error;
}

function parseJsonc(text, path) {
  try {
    return JSON.parse(text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1"));
  } catch (error) {
    fail("wrangler-parse", `${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trackedFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function isAllowedWorkerHost(host) {
  const normalized = host.toLowerCase();
  const placeholder = ["<your-subdomain>", workersDev].join(".").toLowerCase();
  const example = ["example", workersDev].join(".").toLowerCase();
  return normalized === placeholder || normalized === example || normalized.endsWith(`.example.${workersDev}`.toLowerCase());
}

function checkText(relativePath, text, forbiddenDigests = forbiddenTokenDigests) {
  for (const marker of markers) {
    if (authorityExceptions.has(relativePath) && marker === hostMarker) continue;
    if (text.toLowerCase().includes(marker.toLowerCase())) {
      fail("forbidden-marker", `${relativePath} contains a forbidden private marker`);
    }
  }
  const personalPath = text.match(personalPathPattern);
  if (personalPath) fail("private-path", `${relativePath} contains ${personalPath[0]}`);

  for (const match of text.matchAll(workerHostPattern)) {
    if (!isAllowedWorkerHost(match[0])) fail("worker-host", `${relativePath} contains ${match[0]}`);
  }

  for (const candidateTokenPattern of candidateTokenPatterns) {
    for (const match of text.matchAll(candidateTokenPattern)) {
      const digest = createHash("sha256").update(match[1].toLowerCase()).digest("hex");
      if (forbiddenDigests.has(digest)) fail("forbidden-resource", `${relativePath} contains a forbidden identifier`);
    }
  }

  if (!authorityExceptions.has(relativePath) && text.toLowerCase().includes(internalHostPath.toLowerCase())) {
    fail("private-host-path", `${relativePath} contains a host-internal path`);
  }
}

function checkResourceValue(relativePath, key, value) {
  if (typeof value !== "string") fail("wrangler-resource", `${relativePath} ${key} is not a string`);
  if (/^REPLACE_WITH_[A-Z0-9_]+$/.test(value) || fakeResourceValues.has(value)) return;
  fail("wrangler-resource", `${relativePath} ${key} is not a placeholder or explicit fake value`);
}

function checkWranglerBindings(relativePath, config, scope) {
  const prefix = scope.length === 0 ? "" : `${scope}.`;
  if (config.d1_databases !== undefined && !Array.isArray(config.d1_databases)) {
    fail("wrangler-shape", `${relativePath} ${prefix}d1_databases is not an array`);
  }
  for (const entry of config.d1_databases ?? []) {
    if (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "database_id")) {
      checkResourceValue(relativePath, `${prefix}d1_databases.database_id`, entry.database_id);
    }
    if (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "preview_database_id")) {
      checkResourceValue(relativePath, `${prefix}d1_databases.preview_database_id`, entry.preview_database_id);
    }
  }
  if (config.hyperdrive !== undefined && !Array.isArray(config.hyperdrive)) {
    fail("wrangler-shape", `${relativePath} ${prefix}hyperdrive is not an array`);
  }
  for (const entry of config.hyperdrive ?? []) {
    if (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "id")) {
      checkResourceValue(relativePath, `${prefix}hyperdrive.id`, entry.id);
    }
  }
  if (config.vars !== undefined && (config.vars === null || typeof config.vars !== "object" || Array.isArray(config.vars))) {
    fail("wrangler-shape", `${relativePath} ${prefix}vars is not an object`);
  }
  for (const [key, value] of Object.entries(config.vars ?? {})) {
    if (/DATABASE_ID|HYPERDRIVE.*ID/i.test(key)) checkResourceValue(relativePath, `${prefix}vars.${key}`, value);
  }
  if (config.env !== undefined && (config.env === null || typeof config.env !== "object" || Array.isArray(config.env))) {
    fail("wrangler-shape", `${relativePath} ${prefix}env is not an object`);
  }
  for (const [environment, environmentConfig] of Object.entries(config.env ?? {})) {
    if (environmentConfig === null || typeof environmentConfig !== "object" || Array.isArray(environmentConfig)) {
      fail("wrangler-shape", `${relativePath} ${prefix}env.${environment} is not an object`);
    }
    checkWranglerBindings(relativePath, environmentConfig, scope.length === 0 ? `env.${environment}` : `${scope}.env.${environment}`);
  }
}

function checkWrangler(relativePath, text) {
  checkWranglerBindings(relativePath, parseJsonc(text, relativePath), "");
}

function scanTree(repoRoot, options = {}) {
  const digests = options.forbiddenTokenDigests ?? forbiddenTokenDigests;
  const files = trackedFiles(repoRoot);
  for (const relativePath of files) {
    const absolutePath = join(repoRoot, relativePath);
    // During an un-staged cleanup, git ls-files still reports paths deleted
    // from the working tree. The guard must tolerate those pending deletions.
    if (!existsSync(absolutePath)) continue;
    if (!relativePath.includes("/") && rootNotePattern.test(relativePath)) {
      fail("root-note", `${relativePath} is a tracked root note`);
    }
    if (relativePath.startsWith(".artifacts/") && !artifactAllowlist.has(relativePath)) {
      fail("artifact", `${relativePath} is outside the shrink-only allowlist`);
    }
    const text = readFileSync(absolutePath, "utf8");
    checkText(relativePath, text, digests);
    if (/^(.+\/)?wrangler[^/]*\.jsonc$/i.test(relativePath)) checkWrangler(relativePath, text);
  }
  return {
    trackedFiles: files.filter((relativePath) => existsSync(join(repoRoot, relativePath))).length,
    trackedBytes: files.filter((relativePath) => existsSync(join(repoRoot, relativePath)))
      .reduce((sum, relativePath) => sum + readFileSync(join(repoRoot, relativePath)).byteLength, 0),
    keptArtifacts: files.filter((relativePath) => relativePath.startsWith(".artifacts/") && existsSync(join(repoRoot, relativePath))).length,
  };
}

function gitAdd(repoRoot, paths) {
  execFileSync("git", ["add", ...paths], { cwd: repoRoot, stdio: "ignore" });
}

function makeSelfTestRepo(extraFiles = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "sdt-g105-public-tree-"));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot, stdio: "ignore" });
  mkdirSync(join(repoRoot, "scripts"), { recursive: true });
  mkdirSync(join(repoRoot, ".artifacts"), { recursive: true });
  writeFileSync(join(repoRoot, ".gitignore"), ".artifacts/\n");
  writeFileSync(join(repoRoot, "safe.txt"), [["host=<your-subdomain>", workersDev].join("."), "resource=REPLACE_WITH_SAFE_ID"].join("\n"));
  writeFileSync(join(repoRoot, "wrangler.jsonc"), JSON.stringify({
    d1_databases: [
      { binding: "D1", database_id: "REPLACE_WITH_SAFE_PIPELINE_ID" },
      { binding: "D1_MV", database_id: "00000000-0000-0000-0000-000000000001" },
    ],
    hyperdrive: [{ binding: "HYPERDRIVE", id: "REPLACE_WITH_SAFE_HYPERDRIVE_ID" }],
    vars: { SAFE_DATABASE_ID: "REPLACE_WITH_SAFE_VAR_ID" },
  }, null, 2));
  for (const [relativePath, contents] of extraFiles) {
    const absolutePath = join(repoRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  const tracked = [".gitignore", "safe.txt", "wrangler.jsonc", ...extraFiles.map(([relativePath]) => relativePath)];
  gitAdd(repoRoot, tracked.filter((relativePath) => !relativePath.startsWith(".artifacts/")));
  for (const [relativePath] of extraFiles.filter(([relativePath]) => relativePath.startsWith(".artifacts/"))) {
    gitAdd(repoRoot, ["-f", relativePath]);
  }
  return repoRoot;
}

function expectFailure(repoRoot, kind, options = {}) {
  try {
    scanTree(repoRoot, options);
  } catch (error) {
    if (error?.kind === kind) return;
    throw new Error(`public-tree-self-test: expected ${kind}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`public-tree-self-test: expected ${kind} failure`);
}

function runSelfTest() {
  const repos = [];
  const syntheticUuid = randomUUID();
  const syntheticHex = randomBytes(16).toString("hex");
  const syntheticForbiddenDigests = new Set([
    syntheticUuid,
    syntheticHex,
  ].map((token) => createHash("sha256").update(token.toLowerCase()).digest("hex")));
  const selfTestOptions = { forbiddenTokenDigests: syntheticForbiddenDigests };
  try {
    const safeRepo = makeSelfTestRepo();
    repos.push(safeRepo);
    const safeResult = scanTree(safeRepo, selfTestOptions);
    writeFileSync(join(safeRepo, ".artifacts", "ignored-output.json"), "ignored");
    writeFileSync(join(safeRepo, "sdt-untracked.md"), "untracked note");
    if (scanTree(safeRepo, selfTestOptions).trackedFiles !== safeResult.trackedFiles) {
      throw new Error("public-tree-self-test: ignored output or untracked note became tracked");
    }

    const rootNoteRepo = makeSelfTestRepo([["SDT-mutant.md", "tracked note"]]);
    repos.push(rootNoteRepo);
    expectFailure(rootNoteRepo, "root-note", selfTestOptions);
    const emptyRootNoteRepo = makeSelfTestRepo([["sdt-.md", "tracked note"]]);
    repos.push(emptyRootNoteRepo);
    expectFailure(emptyRootNoteRepo, "root-note", selfTestOptions);
    const uppercaseEmptyRootNoteRepo = makeSelfTestRepo([["SDT-.md", "tracked note"]]);
    repos.push(uppercaseEmptyRootNoteRepo);
    expectFailure(uppercaseEmptyRootNoteRepo, "root-note", selfTestOptions);
    const artifactRepo = makeSelfTestRepo([[".artifacts/not-allowlisted.json", "tracked output"]]);
    repos.push(artifactRepo);
    expectFailure(artifactRepo, "artifact", selfTestOptions);
    const markerRepo = makeSelfTestRepo([["marker.txt", markers[0]]]);
    repos.push(markerRepo);
    expectFailure(markerRepo, "forbidden-marker", selfTestOptions);
    const pathRepo = makeSelfTestRepo([["path.txt", ["", "home", "alice", "private"].join("/")]]);
    repos.push(pathRepo);
    expectFailure(pathRepo, "private-path", selfTestOptions);
    const hostRepo = makeSelfTestRepo([["host.txt", ["foo", workersDev].join(".")]]);
    repos.push(hostRepo);
    expectFailure(hostRepo, "worker-host", selfTestOptions);
    const uuid = ["12345678", "-", "1234", "-", "4234", "-", "8234", "-", "123456789abc"].join("");
    const uuidRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({ d1_databases: [{ database_id: uuid }] })]]);
    repos.push(uuidRepo);
    expectFailure(uuidRepo, "wrangler-resource", selfTestOptions);
    const hex = Array.from({ length: 32 }, (_, index) => "abcdef0123456789"[index % 16]).join("");
    const hexRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({ hyperdrive: [{ id: hex }] })]]);
    repos.push(hexRepo);
    expectFailure(hexRepo, "wrangler-resource", selfTestOptions);
    const nestedUuid = ["22345678", "-", "1234", "-", "4234", "-", "8234", "-", "223456789abc"].join("");
    const nestedUuidRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({
      env: { production: { d1_databases: [{ database_id: nestedUuid }] } },
    })]]);
    repos.push(nestedUuidRepo);
    expectFailure(nestedUuidRepo, "wrangler-resource", selfTestOptions);
    const nestedHex = Array.from({ length: 32 }, (_, index) => "fedcba9876543210"[index % 16]).join("");
    const nestedHexRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({
      env: { preview: { hyperdrive: [{ id: nestedHex }] } },
    })]]);
    repos.push(nestedHexRepo);
    expectFailure(nestedHexRepo, "wrangler-resource", selfTestOptions);
    const nestedVarsRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({
      env: { staging: { vars: { NESTED_DATABASE_ID: nestedHex } } },
    })]]);
    repos.push(nestedVarsRepo);
    expectFailure(nestedVarsRepo, "wrangler-resource", selfTestOptions);
    const prefixedForbiddenRepo = makeSelfTestRepo([["resource.txt", `prefix${syntheticUuid}`]]);
    repos.push(prefixedForbiddenRepo);
    expectFailure(prefixedForbiddenRepo, "forbidden-resource", selfTestOptions);
    const suffixedForbiddenRepo = makeSelfTestRepo([["resource.txt", `${syntheticUuid}suffix`]]);
    repos.push(suffixedForbiddenRepo);
    expectFailure(suffixedForbiddenRepo, "forbidden-resource", selfTestOptions);
    const underscoreJoinedForbiddenRepo = makeSelfTestRepo([["resource.txt", `before_${syntheticHex}_after`]]);
    repos.push(underscoreJoinedForbiddenRepo);
    expectFailure(underscoreJoinedForbiddenRepo, "forbidden-resource", selfTestOptions);
    const replaceWithForbiddenRepo = makeSelfTestRepo([["resource.txt", `REPLACE_WITH_${syntheticUuid}`]]);
    repos.push(replaceWithForbiddenRepo);
    expectFailure(replaceWithForbiddenRepo, "forbidden-resource", selfTestOptions);
    const invalidPlaceholder = randomUUID();
    const invalidDatabasePlaceholderRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({
      d1_databases: [{
        database_id: `REPLACE_WITH_${invalidPlaceholder}`,
      }],
    })]]);
    repos.push(invalidDatabasePlaceholderRepo);
    expectFailure(invalidDatabasePlaceholderRepo, "wrangler-resource", selfTestOptions);
    const invalidPreviewPlaceholderRepo = makeSelfTestRepo([["wrangler.jsonc", JSON.stringify({
      d1_databases: [{
        database_id: "REPLACE_WITH_SAFE_PIPELINE_ID",
        preview_database_id: `REPLACE_WITH_${invalidPlaceholder}`,
      }],
    })]]);
    repos.push(invalidPreviewPlaceholderRepo);
    expectFailure(invalidPreviewPlaceholderRepo, "wrangler-resource", selfTestOptions);
    const privateHostPathRepo = makeSelfTestRepo([["path.txt", internalHostPath]]);
    repos.push(privateHostPathRepo);
    expectFailure(privateHostPathRepo, "private-host-path", selfTestOptions);
    const mixedCasePrivateHostPathRepo = makeSelfTestRepo([["path.txt", ["InTeNtS", "/", "SeKiBaN-DCB-TS", "/"].join("")]]);
    repos.push(mixedCasePrivateHostPathRepo);
    expectFailure(mixedCasePrivateHostPathRepo, "private-host-path", selfTestOptions);
    const authorityRepo = makeSelfTestRepo([["contracts/commit-trace-bundle.json", internalHostPath]]);
    repos.push(authorityRepo);
    scanTree(authorityRepo, selfTestOptions);
    return {
      schema: "sdt-g105-public-tree-self-test/v1",
      passed: [
        "ignored-artifact-output",
        "untracked-root-note",
        "placeholder-worker-host",
        "root-note",
        "empty-root-note",
        "uppercase-empty-root-note",
        "artifact-allowlist",
        "forbidden-marker",
        "private-path",
        "one-label-worker-host",
        "unseen-uuid-resource",
        "unseen-32-hex-resource",
        "nested-uuid-resource",
        "nested-32-hex-resource",
        "nested-vars-resource",
        "prefixed-forbidden-resource-digest",
        "suffixed-forbidden-resource-digest",
        "underscore-joined-forbidden-resource-digest",
        "replace-with-forbidden-resource-digest",
        "strict-placeholder-resource-value",
        "strict-preview-placeholder-resource-value",
        "private-host-path",
        "mixed-case-private-host-path",
        "authority-exception",
      ],
    };
  } finally {
    for (const repoRoot of repos) rmSync(repoRoot, { recursive: true, force: true });
  }
}

try {
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify(runSelfTest())}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ schema, ...scanTree(root) }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

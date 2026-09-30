#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DOMAIN_SEPARATOR = "sekiban-dcb-ts/g38-m-change-manifest/v1";
const RECEIVER_WORKER = "sekiban-dcb-meeting-room-doorbell";
const CONFIG_PATH = "samples/meeting-room/wrangler.g32-final-receiver.jsonc";
const PACKAGE_PATH = "package.json";
const MANIFEST_PATH = "contracts/g38-m-change-manifest.json";
const EVIDENCE_PATH = "docs/SDT-G38-m-evidence.json";
const WITNESS_SCRIPT_PATH = "scripts/deploy/g38-m-witness.mjs";
const WITNESS_TYPES_PATH = "scripts/deploy/g38-m-witness.d.mts";
const WITNESS_SCRIPT_VALUE = "node scripts/deploy/g38-m-witness.mjs";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This is the sealed packet-side row identity, deliberately independent from M7.
const EXTERNAL_ROW_IDENTITY = Object.freeze([
  ["M1", `${CONFIG_PATH}#/workers_dev`, "add"],
  ["M2", `${CONFIG_PATH}#/preview_urls`, "add"],
  ["M3", WITNESS_SCRIPT_PATH, "new-file"],
  ["M4", WITNESS_TYPES_PATH, "new-file"],
  ["M5", `${PACKAGE_PATH}#/scripts/g38:m:witness`, "add"],
  ["M6", EVIDENCE_PATH, "new-file-evidence-only"],
  ["M7", MANIFEST_PATH, "new-file-self"],
]);

const EXPECTED_ROWS = Object.freeze([
  { rowId: "M1", path: CONFIG_PATH, target: "/workers_dev", changeKind: "add", expectedValue: false },
  { rowId: "M2", path: CONFIG_PATH, target: "/preview_urls", changeKind: "add", expectedValue: false },
  { rowId: "M3", path: WITNESS_SCRIPT_PATH, target: "<whole-file>", changeKind: "new-file" },
  { rowId: "M4", path: WITNESS_TYPES_PATH, target: "<whole-file>", changeKind: "new-file" },
  { rowId: "M5", path: PACKAGE_PATH, target: "/scripts/g38:m:witness", changeKind: "add", expectedValue: WITNESS_SCRIPT_VALUE },
  { rowId: "M6", path: EVIDENCE_PATH, target: "<whole-file>", changeKind: "new-file-evidence-only" },
  { rowId: "M7", path: MANIFEST_PATH, target: "<whole-file>", changeKind: "new-file-self" },
]);

function fail(message) {
  throw new Error(`G38 M: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail(`canonical JSON rejects ${typeof value}`);
}

function equal(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function manifestDigest(manifest) {
  const source = object(manifest, "manifest");
  const projection = { ...source };
  delete projection.selfDigest;
  const bytes = Buffer.concat([
    Buffer.from(DOMAIN_SEPARATOR, "utf8"),
    Buffer.from([0]),
    Buffer.from(canonicalJson(projection), "utf8"),
  ]);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// JSON.parse silently accepts duplicate keys. The self-digest contract does not.
function skipWhitespace(source, index) {
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return index;
}

function parseJsonStringAt(source, index) {
  if (source[index] !== '"') fail("manifest parser expected a quoted property name");
  let cursor = index + 1;
  let escaped = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (!escaped && character === '"') return { value: JSON.parse(source.slice(index, cursor + 1)), next: cursor + 1 };
    if (!escaped && character === "\\") escaped = true;
    else escaped = false;
    cursor += 1;
  }
  fail("manifest parser found an unterminated string");
}

function skipJsonValue(source, index) {
  let cursor = skipWhitespace(source, index);
  if (source[cursor] === '"') return parseJsonStringAt(source, cursor).next;
  if (source[cursor] === "{") {
    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] === "}") return cursor + 1;
    while (cursor < source.length) {
      cursor = parseJsonStringAt(source, cursor).next;
      cursor = skipWhitespace(source, cursor);
      if (source[cursor] !== ":") fail("manifest parser expected an object colon");
      cursor = skipWhitespace(source, skipJsonValue(source, cursor + 1));
      if (source[cursor] === "}") return cursor + 1;
      if (source[cursor] !== ",") fail("manifest parser expected an object comma");
      cursor = skipWhitespace(source, cursor + 1);
    }
    fail("manifest parser found an unterminated object");
  }
  if (source[cursor] === "[") {
    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] === "]") return cursor + 1;
    while (cursor < source.length) {
      cursor = skipWhitespace(source, skipJsonValue(source, cursor));
      if (source[cursor] === "]") return cursor + 1;
      if (source[cursor] !== ",") fail("manifest parser expected an array comma");
      cursor = skipWhitespace(source, cursor + 1);
    }
    fail("manifest parser found an unterminated array");
  }
  const scalar = source.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u)?.[0];
  if (!scalar) fail("manifest parser found an invalid scalar");
  return cursor + scalar.length;
}

function topLevelKeys(source) {
  let cursor = skipWhitespace(source, 0);
  if (source[cursor] !== "{") fail("manifest must be a JSON object");
  cursor = skipWhitespace(source, cursor + 1);
  const keys = [];
  if (source[cursor] === "}") return keys;
  while (cursor < source.length) {
    const key = parseJsonStringAt(source, cursor);
    keys.push(key.value);
    cursor = skipWhitespace(source, key.next);
    if (source[cursor] !== ":") fail("manifest parser expected a top-level colon");
    cursor = skipWhitespace(source, skipJsonValue(source, cursor + 1));
    if (source[cursor] === "}") {
      if (skipWhitespace(source, cursor + 1) !== source.length) fail("manifest has trailing data");
      return keys;
    }
    if (source[cursor] !== ",") fail("manifest parser expected a top-level comma");
    cursor = skipWhitespace(source, cursor + 1);
  }
  fail("manifest parser found an unterminated root object");
}

function parseManifest(raw) {
  if (typeof raw !== "string") return clone(raw);
  const keys = topLevelKeys(raw);
  if (new Set(keys).size !== keys.length) fail("manifest has duplicate top-level fields");
  try { return JSON.parse(raw); } catch { fail("manifest is not valid JSON"); }
}

function rowIdentity(row) {
  return [row.rowId, row.target === "<whole-file>" ? row.path : `${row.path}#${row.target}`, row.changeKind];
}

function assertRows(rows) {
  if (!Array.isArray(rows) || rows.length !== EXPECTED_ROWS.length) fail("manifest must have exactly M1 through M7");
  const byId = new Map();
  for (const row of rows) {
    const value = object(row, "manifest row");
    const id = text(value.rowId, "manifest rowId");
    if (byId.has(id)) fail(`manifest duplicates ${id}`);
    byId.set(id, value);
  }
  for (const expected of EXPECTED_ROWS) {
    const row = byId.get(expected.rowId);
    if (!row) fail(`manifest is missing ${expected.rowId}`);
    const keys = Object.hasOwn(expected, "expectedValue")
      ? ["rowId", "path", "target", "changeKind", "expectedValue"]
      : ["rowId", "path", "target", "changeKind"];
    exactKeys(row, keys, `manifest ${expected.rowId}`);
    for (const key of ["rowId", "path", "target", "changeKind"]) {
      if (row[key] !== expected[key]) fail(`manifest ${expected.rowId} ${key} differs from packet authority`);
    }
    if (Object.hasOwn(expected, "expectedValue") && row.expectedValue !== expected.expectedValue) fail(`manifest ${expected.rowId} expectedValue differs from packet authority`);
  }
  const actual = rows.map(rowIdentity).sort((left, right) => left[0].localeCompare(right[0]));
  const expected = EXTERNAL_ROW_IDENTITY.map((row) => [...row]).sort((left, right) => left[0].localeCompare(right[0]));
  if (!equal(actual, expected)) fail("manifest row identity differs from external packet authority");
}

export function assertMManifest(raw) {
  const manifest = parseManifest(raw);
  exactKeys(manifest, ["schemaVersion", "rows", "selfDigest"], "manifest");
  if (manifest.schemaVersion !== "1") fail("manifest schemaVersion must be the string 1");
  assertRows(manifest.rows);
  if (typeof manifest.selfDigest !== "string" || !SHA256.test(manifest.selfDigest)) fail("manifest selfDigest must be lowercase sha256:<64 hex>");
  const expected = manifestDigest(manifest);
  if (manifest.selfDigest !== expected) fail("manifest selfDigest is not the required deletion projection digest");
  return Object.freeze({ manifest, selfDigest: expected });
}

function git(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  } catch (error) {
    fail(`git ${args.join(" ")} failed: ${error?.stderr?.toString().trim() || error?.message || "unknown error"}`);
  }
}

function gitFile(repo, revision, path) {
  return git(repo, ["show", revision === ":" ? `:${path}` : `${revision}:${path}`]);
}

function nameStatus(repo, base, source) {
  const args = source === ":" ? ["diff", "--cached", "--name-status", "--no-renames", base] : ["diff", "--name-status", "--no-renames", base, source];
  const output = git(repo, args).trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [status, ...paths] = line.split("\t");
    if (paths.length !== 1) fail(`unsupported diff record ${line}`);
    return { status, path: paths[0] };
  });
}

function assertPathSet(actual, expected, label) {
  const normalized = (rows) => [...rows].sort((left, right) => left.path.localeCompare(right.path));
  const current = normalized(actual);
  const wanted = normalized(expected);
  if (current.length !== wanted.length || current.some((row, index) => row.path !== wanted[index].path || row.status !== wanted[index].status)) {
    fail(`${label} is not exact: got ${current.map((row) => `${row.status}:${row.path}`).join(", ")}`);
  }
}

function sourceConfigWithMSettings(base) {
  const closing = base.lastIndexOf("}");
  if (closing < 0 || base.slice(closing + 1).trim().length !== 0) fail("baseline receiver config has no terminal root object");
  return `${base.slice(0, closing).replace(/\s+$/u, "")},\n  "workers_dev": false,\n  "preview_urls": false\n${base.slice(closing)}`;
}

function assertConfigOnlyM(baseRaw, sourceRaw) {
  const base = JSON.parse(baseRaw);
  const source = JSON.parse(sourceRaw);
  if (Object.hasOwn(base, "workers_dev") || Object.hasOwn(base, "preview_urls")) fail("M base already contains a public-surface setting");
  if (source.workers_dev !== false || source.preview_urls !== false) fail("M1 and M2 must both be literal false");
  if (sourceRaw !== sourceConfigWithMSettings(baseRaw)) fail("receiver config changed bytes outside M1/M2");
  const projection = { ...source };
  delete projection.workers_dev;
  delete projection.preview_urls;
  if (!equal(base, projection)) fail("receiver config changed non-M semantics");
  for (const field of ["durable_objects", "migrations", "d1_databases", "queues", "services"]) {
    if (!equal(base[field], source[field])) fail(`receiver config changed protected ${field}`);
  }
}

function assertPackageOnlyM5(baseRaw, sourceRaw) {
  const base = JSON.parse(baseRaw);
  const source = JSON.parse(sourceRaw);
  if (!base.scripts || !source.scripts || Object.hasOwn(base.scripts, "g38:m:witness")) fail("M5 baseline script state is invalid");
  if (source.scripts["g38:m:witness"] !== WITNESS_SCRIPT_VALUE) fail("M5 script value differs from packet authority");
  const projection = clone(source);
  delete projection.scripts["g38:m:witness"];
  if (!equal(base, projection)) fail("package.json changed outside M5");
}

function configDigest(raw) {
  return `sha256:${sha256(raw)}`;
}

export function assertDeployableUniverse({ repo = process.cwd(), base, source }) {
  const expected = [
    { status: "M", path: CONFIG_PATH },
    { status: "M", path: PACKAGE_PATH },
    { status: "A", path: WITNESS_SCRIPT_PATH },
    { status: "A", path: WITNESS_TYPES_PATH },
    { status: "A", path: MANIFEST_PATH },
  ];
  assertPathSet(nameStatus(repo, base, source), expected, "M deployable universe");
  const baseConfig = gitFile(repo, base, CONFIG_PATH);
  const sourceConfig = gitFile(repo, source, CONFIG_PATH);
  assertConfigOnlyM(baseConfig, sourceConfig);
  assertPackageOnlyM5(gitFile(repo, base, PACKAGE_PATH), gitFile(repo, source, PACKAGE_PATH));
  for (const path of [WITNESS_SCRIPT_PATH, WITNESS_TYPES_PATH]) if (gitFile(repo, source, path).trim().length === 0) fail(`${path} must be non-empty`);
  const manifest = assertMManifest(gitFile(repo, source, MANIFEST_PATH));
  return Object.freeze({ base, source, manifestSelfDigest: manifest.selfDigest, configDigest: configDigest(sourceConfig), paths: expected.map((entry) => entry.path) });
}

function requireSha(value, label) {
  const result = text(value, label);
  if (!GIT_SHA.test(result)) fail(`${label} must be a lowercase 40-hex SHA`);
  return result;
}

function distinctStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) fail(`${label} must be an array of non-empty strings`);
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
  return value;
}

function assertRegistry(snapshot, phase) {
  exactKeys(snapshot, ["accountSubdomain", "activeDeployment", "aliases", "settings", "versionedPreviewUrls", "workersDevUrl"], `${phase} registry`);
  text(snapshot.accountSubdomain, `${phase} accountSubdomain`);
  text(snapshot.workersDevUrl, `${phase} workersDevUrl`);
  exactKeys(snapshot.settings, ["previewsEnabled", "workersDevEnabled"], `${phase} settings`);
  if (typeof snapshot.settings.workersDevEnabled !== "boolean" || typeof snapshot.settings.previewsEnabled !== "boolean") fail(`${phase} settings are invalid`);
  exactKeys(snapshot.activeDeployment, ["createdOn", "deploymentId", "message", "versions"], `${phase} deployment`);
  if (!UUID.test(text(snapshot.activeDeployment.deploymentId, `${phase} deployment id`))) fail(`${phase} deployment id is invalid`);
  text(snapshot.activeDeployment.createdOn, `${phase} deployment createdOn`);
  text(snapshot.activeDeployment.message, `${phase} deployment message`);
  if (!Array.isArray(snapshot.activeDeployment.versions) || snapshot.activeDeployment.versions.length === 0) fail(`${phase} deployment has no versions`);
  for (const version of snapshot.activeDeployment.versions) {
    exactKeys(version, ["percentage", "versionId"], `${phase} deployment version`);
    if (!UUID.test(text(version.versionId, `${phase} deployment version id`)) || typeof version.percentage !== "number" || version.percentage <= 0 || version.percentage > 100) fail(`${phase} deployment version is invalid`);
  }
  distinctStrings(snapshot.versionedPreviewUrls, `${phase} versioned preview URLs`);
  if (!Array.isArray(snapshot.aliases)) fail(`${phase} aliases must be an array`);
  for (const alias of snapshot.aliases) {
    exactKeys(alias, ["alias", "url", "versionId"], `${phase} alias`);
    text(alias.alias, `${phase} alias name`);
    text(alias.url, `${phase} alias URL`);
    if (!UUID.test(text(alias.versionId, `${phase} alias version id`))) fail(`${phase} alias version id is invalid`);
  }
}

function publicUrls(registry) {
  const urls = [];
  if (registry.settings.workersDevEnabled) urls.push(registry.workersDevUrl);
  if (registry.settings.previewsEnabled) urls.push(...registry.versionedPreviewUrls, ...registry.aliases.map((item) => item.url));
  return [...new Set(urls)].sort();
}

function assertWitness(value, phase) {
  const expectedKeys = phase === "pre"
    ? ["accountId", "capturedAt", "phase", "registry", "workerName"]
    : ["accountId", "capturedAt", "phase", "preCapturedUrls", "rechecks", "registry", "workerName"];
  exactKeys(value, expectedKeys, `${phase} witness`);
  if (value.phase !== phase || value.workerName !== RECEIVER_WORKER) fail(`${phase} witness identity is invalid`);
  if (!/^[0-9a-f]{32}$/i.test(text(value.accountId, `${phase} account id`))) fail(`${phase} account id is invalid`);
  text(value.capturedAt, `${phase} capturedAt`);
  assertRegistry(value.registry, phase);
  if (phase === "post") {
    const urls = distinctStrings(value.preCapturedUrls, "post pre-captured URLs");
    if (!Array.isArray(value.rechecks) || value.rechecks.length !== urls.length) fail("post must recheck every pre-captured URL exactly once");
    const rechecked = new Map();
    for (const row of value.rechecks) {
      exactKeys(row, ["status", "url"], "post recheck");
      const url = text(row.url, "post recheck URL");
      if (row.status !== 404 || rechecked.has(url)) fail(`post recheck must uniquely observe HTTP 404 for ${url}`);
      rechecked.set(url, row);
    }
    for (const url of urls) if (!rechecked.has(url)) fail(`post recheck is missing ${url}`);
    if (value.registry.settings.workersDevEnabled !== false || value.registry.settings.previewsEnabled !== false) fail("post remote settings readback must be workers_dev=false and preview_urls=false");
  }
  return value;
}

export function assertMEvidence(evidence, { baseCommit, sourceCommit, configDigest: expectedConfigDigest, manifestSelfDigest }) {
  exactKeys(evidence, ["baseCommit", "configDigest", "deployIdentity", "manifestSelfDigest", "phase", "phaseMDoesNotCloseFenceSplit", "postWitness", "preWitness", "recordedAt", "schemaVersion", "sourceCommit", "unit"], "M evidence");
  if (evidence.schemaVersion !== "1" || evidence.unit !== "SDT-G38" || evidence.phase !== "M") fail("M evidence identity is invalid");
  text(evidence.recordedAt, "M evidence recordedAt");
  if (requireSha(evidence.baseCommit, "M evidence baseCommit") !== requireSha(baseCommit, "M expected baseCommit")) fail("M evidence baseCommit mismatch");
  if (requireSha(evidence.sourceCommit, "M evidence sourceCommit") !== requireSha(sourceCommit, "M expected sourceCommit")) fail("M evidence sourceCommit mismatch");
  if (evidence.configDigest !== expectedConfigDigest || !SHA256.test(evidence.configDigest)) fail("M evidence config digest mismatch");
  if (evidence.manifestSelfDigest !== manifestSelfDigest || !SHA256.test(evidence.manifestSelfDigest)) fail("M evidence manifest digest mismatch");
  if (evidence.phaseMDoesNotCloseFenceSplit !== "Phase M does NOT close the AC4 fence split.") fail("M evidence must explicitly state that AC4 remains open");
  const pre = assertWitness(evidence.preWitness, "pre");
  const post = assertWitness(evidence.postWitness, "post");
  if (pre.accountId !== post.accountId) fail("M witnesses use different account ids");
  exactKeys(evidence.deployIdentity, ["deploymentId", "message", "percentage", "versionId", "workerName"], "M deploy identity");
  const identity = evidence.deployIdentity;
  if (identity.workerName !== RECEIVER_WORKER || !UUID.test(text(identity.deploymentId, "M deploy identity deploymentId")) || !UUID.test(text(identity.versionId, "M deploy identity versionId")) || identity.percentage !== 100 || identity.message !== `SDT-G38 Phase M ${sourceCommit}`) fail("M deploy identity is invalid");
  if (identity.deploymentId !== post.registry.activeDeployment.deploymentId || identity.message !== post.registry.activeDeployment.message || !equal([{ versionId: identity.versionId, percentage: 100 }], post.registry.activeDeployment.versions)) fail("M deploy identity is not the post-M active deployment registry value");
  return Object.freeze({ baseCommit, sourceCommit, configDigest: expectedConfigDigest, manifestSelfDigest, deployIdentity: identity });
}

export function assertEvidenceOnlyUniverse({ repo = process.cwd(), source, evidence }) {
  assertPathSet(nameStatus(repo, source, evidence), [{ status: "A", path: EVIDENCE_PATH }], "M evidence-only universe");
  for (const path of [CONFIG_PATH, PACKAGE_PATH, WITNESS_SCRIPT_PATH, WITNESS_TYPES_PATH, MANIFEST_PATH]) {
    if (gitFile(repo, source, path) !== gitFile(repo, evidence, path)) fail(`${path} changed after the M source seal`);
  }
  const manifest = assertMManifest(gitFile(repo, source, MANIFEST_PATH));
  return assertMEvidence(JSON.parse(gitFile(repo, evidence, EVIDENCE_PATH)), {
    baseCommit: git(repo, ["rev-parse", `${source}^`]).trim(),
    sourceCommit: source,
    configDigest: configDigest(gitFile(repo, source, CONFIG_PATH)),
    manifestSelfDigest: manifest.selfDigest,
  });
}

async function registryGet({ token, accountId, path, fetchImpl }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: "GET",
    cache: "no-store",
    redirect: "manual",
    headers: { authorization: `Bearer ${token}` },
  });
  let body;
  try { body = await response.json(); } catch { fail(`Cloudflare GET ${path} did not return JSON`); }
  if (response.status !== 200 || body?.success !== true || !Object.hasOwn(body, "result")) fail(`Cloudflare GET ${path} failed with HTTP ${response.status}`);
  return body.result;
}

function normalizeDeployment(value) {
  const versions = value?.versions;
  if (!Array.isArray(versions) || versions.length === 0) fail("remote deployments registry has no active versions");
  return {
    deploymentId: text(value.id, "remote deployment id"),
    createdOn: text(value.created_on, "remote deployment created_on"),
    message: text(value.annotations?.["workers/message"] ?? "", "remote deployment message"),
    versions: versions.map((row) => ({ versionId: text(row.version_id, "remote deployment version id"), percentage: row.percentage })),
  };
}

function makeRegistry({ accountSubdomain, settings, versions, deployments, workerName }) {
  const subdomain = text(accountSubdomain?.subdomain, "remote account workers.dev subdomain");
  if (!Array.isArray(versions) || !Array.isArray(deployments?.deployments) || deployments.deployments.length === 0) fail("remote registry is incomplete");
  const activeDeployment = normalizeDeployment(deployments.deployments[0]);
  const versionsById = new Map();
  for (const version of versions) {
    const id = text(version?.id, "remote version id");
    if (versionsById.has(id)) fail(`remote version registry duplicates ${id}`);
    versionsById.set(id, version);
  }
  const versionedPreviewUrls = [];
  for (const active of activeDeployment.versions) {
    const version = versionsById.get(active.versionId);
    if (!version) fail(`remote active deployment version ${active.versionId} is missing from version registry`);
    if (!Array.isArray(version.urls) || version.urls.some((url) => typeof url !== "string" || !url.startsWith("https://"))) fail("remote version URL registry is invalid");
    versionedPreviewUrls.push(...version.urls);
  }
  const aliases = [];
  for (const [versionId, version] of versionsById) {
    const alias = version?.annotations?.["workers/alias"];
    if (alias === undefined) continue;
    if (typeof alias !== "string" || !/^[a-z][a-z0-9-]*$/u.test(alias)) fail("remote alias registry contains an invalid alias");
    aliases.push({ alias, versionId, url: `https://${alias}-${workerName}.${subdomain}.workers.dev` });
  }
  aliases.sort((left, right) => left.alias.localeCompare(right.alias));
  if (new Set(aliases.map((item) => item.alias)).size !== aliases.length) fail("remote alias registry contains duplicates");
  if (typeof settings?.enabled !== "boolean" || typeof settings?.previews_enabled !== "boolean") fail("remote subdomain registry is missing enabled settings");
  return {
    accountSubdomain: subdomain,
    settings: { workersDevEnabled: settings.enabled, previewsEnabled: settings.previews_enabled },
    workersDevUrl: `https://${workerName}.${subdomain}.workers.dev`,
    versionedPreviewUrls: [...new Set(versionedPreviewUrls)].sort(),
    aliases,
    activeDeployment,
  };
}

export async function captureRegistryWitness({ phase, accountId, workerName = RECEIVER_WORKER, token, fetchImpl = fetch }) {
  if (phase !== "pre" && phase !== "post") fail("witness phase must be pre or post");
  const account = text(accountId, "Cloudflare account id");
  const secret = text(token, "Cloudflare API token");
  const name = encodeURIComponent(workerName);
  const [accountSubdomain, settings, versions, deployments] = await Promise.all([
    registryGet({ token: secret, accountId: account, path: "/workers/subdomain", fetchImpl }),
    registryGet({ token: secret, accountId: account, path: `/workers/scripts/${name}/subdomain`, fetchImpl }),
    registryGet({ token: secret, accountId: account, path: `/workers/workers/${name}/versions?per_page=100`, fetchImpl }),
    registryGet({ token: secret, accountId: account, path: `/workers/scripts/${name}/deployments`, fetchImpl }),
  ]);
  const registry = makeRegistry({ accountSubdomain, settings, versions, deployments, workerName });
  assertRegistry(registry, phase);
  return Object.freeze({ phase, capturedAt: new Date().toISOString(), accountId: account, workerName, registry });
}

function readToken(path) {
  const token = readFileSync(path, "utf8").trim();
  if (!token) fail("API token file is empty");
  return token;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function probePublicUrl(url) {
  const response = await fetch(url, { method: "GET", cache: "no-store", redirect: "manual" });
  return { url, status: response.status };
}

async function capturePre(accountId, tokenFile, output) {
  const value = await captureRegistryWitness({ phase: "pre", accountId, token: readToken(tokenFile) });
  writeJson(output, value);
  return value;
}

async function capturePost(accountId, tokenFile, beforePath, output) {
  const before = assertWitness(JSON.parse(readFileSync(beforePath, "utf8")), "pre");
  if (before.accountId !== accountId) fail("pre/post witness account mismatch");
  const after = await captureRegistryWitness({ phase: "post", accountId, token: readToken(tokenFile) });
  const preCapturedUrls = publicUrls(before.registry);
  const value = { ...after, preCapturedUrls, rechecks: await Promise.all(preCapturedUrls.map(probePublicUrl)) };
  assertWitness(value, "post");
  writeJson(output, value);
  return value;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function requiredArgument(name) {
  const value = argument(name);
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail(`${name} is required`);
  return value;
}

function assertThrows(action, label) {
  try { action(); } catch { return; }
  fail(`self-test expected ${label} to fail`);
}

function syntheticManifest() {
  const manifest = { schemaVersion: "1", rows: clone(EXPECTED_ROWS) };
  manifest.selfDigest = manifestDigest(manifest);
  return manifest;
}

function syntheticRegistry({ workersDevEnabled = true, previewsEnabled = true, message = "SDT-G38 Phase M 0123456789abcdef0123456789abcdef01234567" } = {}) {
  return {
    accountSubdomain: "example",
    settings: { workersDevEnabled, previewsEnabled },
    workersDevUrl: `https://${RECEIVER_WORKER}.example.workers.dev`,
    versionedPreviewUrls: ["https://version-example.example.workers.dev"],
    aliases: [{ alias: "branch", versionId: "11111111-1111-4111-8111-111111111111", url: `https://branch-${RECEIVER_WORKER}.example.workers.dev` }],
    activeDeployment: { deploymentId: "22222222-2222-4222-8222-222222222222", createdOn: "2026-08-24T00:00:00.000Z", message, versions: [{ versionId: "33333333-3333-4333-8333-333333333333", percentage: 100 }] },
  };
}

function syntheticWitness(phase, registry, preRegistry = registry) {
  const result = { phase, capturedAt: "2026-08-24T00:00:00.000Z", accountId: "REPLACE_WITH_ACCOUNT_ID", workerName: RECEIVER_WORKER, registry };
  if (phase === "post") {
    const urls = publicUrls(preRegistry);
    return { ...result, preCapturedUrls: urls, rechecks: urls.map((url) => ({ url, status: 404 })) };
  }
  return result;
}

function selfTest() {
  const manifest = syntheticManifest();
  assertMManifest(JSON.stringify(manifest));
  for (const [label, mutate] of [
    ["absent selfDigest", (value) => { delete value.selfDigest; }],
    ["renamed selfDigest", (value) => { value.self_digest = value.selfDigest; delete value.selfDigest; }],
    ["additional selfDigest", (value) => { value.otherDigest = value.selfDigest; }],
    ["null replacement", (value) => { value.selfDigest = null; }],
    ["uppercase digest", (value) => { value.selfDigest = value.selfDigest.toUpperCase(); }],
    ["substituted algorithm", (value) => { value.selfDigest = `sha512:${value.selfDigest.slice(7)}`; }],
    ["missing domain separator", (value) => { const projection = { ...value }; delete projection.selfDigest; value.selfDigest = `sha256:${sha256(canonicalJson(projection))}`; }],
    ["extra manifest row", (value) => { value.rows.push({ rowId: "M8", path: "extra", target: "<whole-file>", changeKind: "new-file" }); }],
    ["M5 command", (value) => { value.rows.find((row) => row.rowId === "M5").expectedValue = "wrong"; }],
    ["M7 self bytes", (value) => { value.rows.find((row) => row.rowId === "M7").expectedValue = "forbidden"; }],
  ]) {
    const mutated = clone(manifest);
    mutate(mutated);
    assertThrows(() => assertMManifest(JSON.stringify(mutated)), label);
  }
  const sourcePaths = [
    { status: "M", path: CONFIG_PATH }, { status: "M", path: PACKAGE_PATH }, { status: "A", path: WITNESS_SCRIPT_PATH }, { status: "A", path: WITNESS_TYPES_PATH }, { status: "A", path: MANIFEST_PATH },
  ];
  assertPathSet(sourcePaths, sourcePaths, "self-test preflight excludes M6");
  assertThrows(() => assertPathSet([], [{ status: "A", path: EVIDENCE_PATH }], "self-test postflight requires M6"), "postflight without M6");
  assertThrows(() => assertPathSet([...sourcePaths, { status: "A", path: "src/worker.cloudflare-only.ts" }], sourcePaths, "self-test runtime mutation"), "extra runtime path");
  const baseConfig = '{\n  "name": "receiver"\n}\n';
  const sourceConfig = sourceConfigWithMSettings(baseConfig);
  assertConfigOnlyM(baseConfig, sourceConfig);
  assertThrows(() => assertConfigOnlyM(baseConfig, sourceConfig.replace('"workers_dev": false', '"workers_dev": true')), "wrong M1 value");
  const basePackage = JSON.stringify({ scripts: { test: "test" } });
  assertPackageOnlyM5(basePackage, JSON.stringify({ scripts: { test: "test", "g38:m:witness": WITNESS_SCRIPT_VALUE } }));
  assertThrows(() => assertPackageOnlyM5(basePackage, JSON.stringify({ scripts: { test: "test", extra: "x", "g38:m:witness": WITNESS_SCRIPT_VALUE } })), "extra package script");
  const preRegistry = syntheticRegistry();
  const postRegistry = syntheticRegistry({ workersDevEnabled: false, previewsEnabled: false });
  const preWitness = syntheticWitness("pre", preRegistry);
  const postWitness = syntheticWitness("post", postRegistry, preRegistry);
  const evidence = {
    schemaVersion: "1", unit: "SDT-G38", phase: "M", recordedAt: "2026-08-24T00:00:00.000Z",
    baseCommit: "fedcba9876543210fedcba9876543210fedcba98", sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    configDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", manifestSelfDigest: manifest.selfDigest,
    deployIdentity: { workerName: RECEIVER_WORKER, deploymentId: postRegistry.activeDeployment.deploymentId, versionId: postRegistry.activeDeployment.versions[0].versionId, percentage: 100, message: postRegistry.activeDeployment.message },
    preWitness, postWitness, phaseMDoesNotCloseFenceSplit: "Phase M does NOT close the AC4 fence split.",
  };
  assertMEvidence(evidence, { baseCommit: evidence.baseCommit, sourceCommit: evidence.sourceCommit, configDigest: evidence.configDigest, manifestSelfDigest: manifest.selfDigest });
  assertThrows(() => assertMEvidence({ ...evidence, postWitness: { ...postWitness, rechecks: postWitness.rechecks.slice(1) } }, { baseCommit: evidence.baseCommit, sourceCommit: evidence.sourceCommit, configDigest: evidence.configDigest, manifestSelfDigest: manifest.selfDigest }), "missing exposure recheck");
  assertThrows(() => assertMEvidence({ ...evidence, postWitness: { ...postWitness, registry: { ...postRegistry, settings: { workersDevEnabled: true, previewsEnabled: false } } } }, { baseCommit: evidence.baseCommit, sourceCommit: evidence.sourceCommit, configDigest: evidence.configDigest, manifestSelfDigest: manifest.selfDigest }), "false remote settings readback");
  assertThrows(() => assertMEvidence({ ...evidence, phaseMDoesNotCloseFenceSplit: "Phase M closes AC4." }, { baseCommit: evidence.baseCommit, sourceCommit: evidence.sourceCommit, configDigest: evidence.configDigest, manifestSelfDigest: manifest.selfDigest }), "false AC4 closure claim");
  return { mutations: 17, rowCount: EXTERNAL_ROW_IDENTITY.length };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const result = selfTest();
    process.stdout.write(`G38 M self-test PASS mutations=${result.mutations} rows=${result.rowCount}\n`);
    return;
  }
  const mode = requiredArgument("--mode");
  if (mode === "print-manifest-digest") {
    process.stdout.write(`${manifestDigest(parseManifest(readFileSync(argument("--manifest", MANIFEST_PATH), "utf8")))}\n`);
    return;
  }
  if (mode === "index-preflight") {
    const result = assertDeployableUniverse({ base: requireSha(requiredArgument("--base"), "M base"), source: ":" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (mode === "source-preflight") {
    const result = assertDeployableUniverse({ base: requireSha(requiredArgument("--base"), "M base"), source: requireSha(requiredArgument("--source"), "M source") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (mode === "evidence-postflight") {
    const result = assertEvidenceOnlyUniverse({ source: requireSha(requiredArgument("--source"), "M source"), evidence: requireSha(requiredArgument("--evidence"), "M evidence") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (mode === "capture-pre") {
    const result = await capturePre(requiredArgument("--account-id"), requiredArgument("--token-file"), requiredArgument("--output"));
    process.stdout.write(`G38 M pre-witness captured ${result.workerName}\n`);
    return;
  }
  if (mode === "capture-post") {
    const result = await capturePost(requiredArgument("--account-id"), requiredArgument("--token-file"), requiredArgument("--before"), requiredArgument("--output"));
    process.stdout.write(`G38 M post-witness captured ${result.workerName}\n`);
    return;
  }
  if (mode === "record-evidence") {
    const baseCommit = requireSha(requiredArgument("--base"), "M base");
    const sourceCommit = requireSha(requiredArgument("--source"), "M source");
    const sourceCheck = assertDeployableUniverse({ base: baseCommit, source: sourceCommit });
    if (readFileSync(CONFIG_PATH, "utf8") !== gitFile(process.cwd(), sourceCommit, CONFIG_PATH) || readFileSync(MANIFEST_PATH, "utf8") !== gitFile(process.cwd(), sourceCommit, MANIFEST_PATH)) fail("working tree drifted from sealed M source before evidence recording");
    const preWitness = assertWitness(JSON.parse(readFileSync(requiredArgument("--pre"), "utf8")), "pre");
    const postWitness = assertWitness(JSON.parse(readFileSync(requiredArgument("--post"), "utf8")), "post");
    const deployment = postWitness.registry.activeDeployment;
    if (deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100) fail("M evidence requires one 100 percent active deployment");
    const evidence = {
      schemaVersion: "1", unit: "SDT-G38", phase: "M", recordedAt: new Date().toISOString(), baseCommit, sourceCommit,
      configDigest: sourceCheck.configDigest, manifestSelfDigest: sourceCheck.manifestSelfDigest,
      deployIdentity: { workerName: RECEIVER_WORKER, deploymentId: deployment.deploymentId, versionId: deployment.versions[0].versionId, percentage: deployment.versions[0].percentage, message: deployment.message },
      preWitness, postWitness, phaseMDoesNotCloseFenceSplit: "Phase M does NOT close the AC4 fence split.",
    };
    assertMEvidence(evidence, { baseCommit, sourceCommit, configDigest: sourceCheck.configDigest, manifestSelfDigest: sourceCheck.manifestSelfDigest });
    writeJson(argument("--output", EVIDENCE_PATH), evidence);
    process.stdout.write(`G38 M evidence recorded for ${sourceCommit}\n`);
    return;
  }
  fail(`unsupported mode ${mode}`);
}

if (typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

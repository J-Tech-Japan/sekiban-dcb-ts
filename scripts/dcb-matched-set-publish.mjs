#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageDirectories = Object.freeze([
  ["@sekiban/dcb-core", "packages/dcb-core"],
  ["@sekiban/dcb-domain", "packages/dcb-domain"],
  ["@sekiban/dcb-client", "packages/dcb-client"],
  ["@sekiban/dcb-runtime", "packages/dcb-runtime"],
]);

function error(message) {
  throw new Error(`SDT-G132 matched-set publish: ${message}`);
}

function commandResult(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function loadReleaseRecords() {
  return packageDirectories.map(([name, directory]) => {
    const manifest = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
    return { name, directory: resolve(root, directory), version: manifest.version };
  });
}

function registryQuery(name, version) {
  const result = commandResult(
    "npm",
    ["view", `${name}@${version}`, "--json", "--registry", "https://registry.npmjs.org"],
  );
  if (result.status !== 0) {
    if (/\bE404\b|not found/i.test(result.output)) return null;
    error(`registry query failed for ${name}@${version}: ${result.output.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    error(`registry returned invalid metadata for ${name}@${version}: ${cause.message}`);
  }
}

function localPackIntegrity(record) {
  const destination = mkdtempSync(join(tmpdir(), "sdt-g132-pack-"));
  try {
    const result = commandResult("npm", ["pack", "--json", "--pack-destination", destination], record.directory);
    if (result.status !== 0) error(`local pack failed for ${record.name}: ${result.output.trim()}`);
    const report = JSON.parse(result.stdout)[0];
    const archive = join(destination, report.filename);
    const integrity = report.integrity ??
      `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
    return { integrity, filename: report.filename };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function publishArguments(privateRepository) {
  return ["publish", ...(privateRepository ? [] : ["--provenance"]), "--access", "public"];
}

async function waitForVisible(query, record, { maxAttempts, delayMs, sleep }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const metadata = await query(record.name, record.version);
    if (metadata) return { attempts: attempt, metadata };
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  error(`visibility timeout for ${record.name}@${record.version}`);
}

async function verifyExisting(record, metadata, { tagCommit, privateRepository, packRunner }) {
  if (metadata.version != null && metadata.version !== record.version) {
    error(`${record.name} registry response version ${metadata.version} does not match ${record.version}`);
  }
  if (metadata.gitHead != null && metadata.gitHead !== "") {
    if (metadata.gitHead !== tagCommit) {
      error(`${record.name}@${record.version} has gitHead ${metadata.gitHead}, expected ${tagCommit}`);
    }
    return { proof: "gitHead", gitHead: metadata.gitHead };
  }
  const expected = metadata.dist?.integrity;
  if (!expected) error(`${record.name}@${record.version} has neither gitHead nor dist.integrity`);
  const packed = await packRunner(record, { privateRepository });
  if (packed.integrity !== expected) {
    error(`${record.name}@${record.version} integrity mismatch: registry ${expected}, local ${packed.integrity}`);
  }
  return { proof: "dist.integrity", integrity: expected, privateRepository };
}

export async function publishMatchedSet({
  records,
  tagCommit,
  privateRepository = false,
  registryRunner = registryQuery,
  packRunner = localPackIntegrity,
  publishRunner = async (record, args) => {
    const result = commandResult("npm", args, record.directory);
    if (result.status !== 0) error(`publish failed for ${record.name}@${record.version}: ${result.output.trim()}`);
  },
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  maxAttempts = 180,
  delayMs = 1000,
} = {}) {
  if (!Array.isArray(records) || records.length !== packageDirectories.length) {
    error("exactly four matched package records are required");
  }
  if (!tagCommit) error("tag commit is required for release provenance verification");
  const receipts = [];
  for (const record of records) {
    const existing = await registryRunner(record.name, record.version);
    if (existing) {
      const proof = await verifyExisting(record, existing, { tagCommit, privateRepository, packRunner });
      receipts.push({ package: record.name, version: record.version, action: "skip-verified", proof });
    } else {
      await publishRunner(record, publishArguments(privateRepository));
      receipts.push({ package: record.name, version: record.version, action: "published" });
    }
    const visible = await waitForVisible(registryRunner, record, { maxAttempts, delayMs, sleep });
    const proof = await verifyExisting(record, visible.metadata, { tagCommit, privateRepository, packRunner });
    receipts.at(-1).visible = true;
    receipts.at(-1).finalProof = proof.proof;
  }
  return { status: "PASS", allFourVisible: true, receipts };
}

function fixtureRecords() {
  return packageDirectories.map(([name], index) => ({ name, version: `${index + 1}.0.0`, directory: root }));
}

async function selfTest() {
  const records = fixtureRecords();
  const tagCommit = "tag-commit";
  const metadata = (record, proof = "gitHead") => proof === "gitHead"
    ? { gitHead: tagCommit }
    : { dist: { integrity: `sha512-private-${record.name}` } };
  const newRegistry = () => new Map();
  const query = (store) => async (name, version) => store.get(`${name}@${version}`) ?? null;
  const publish = (store, { privateIntegrity = false } = {}) => async (record) => {
    store.set(`${record.name}@${record.version}`, privateIntegrity
      ? { dist: { integrity: `sha512-private-${record.name}` } }
      : { gitHead: tagCommit });
  };
  const pack = async (record, options) => ({
    integrity: options.privateRepository ? `sha512-private-${record.name}` : `sha512-public-${record.name}`,
  });
  const checks = [];

  const fresh = newRegistry();
  await publishMatchedSet({
    records,
    tagCommit,
    registryRunner: query(fresh),
    publishRunner: publish(fresh),
    packRunner: pack,
    sleep: async () => {},
    maxAttempts: 1,
  });
  assert.equal(fresh.size, records.length, "fresh publish did not publish all four packages");
  checks.push("fresh publish");

  const gitHeadSkip = newRegistry();
  for (const record of records.slice(0, 2)) gitHeadSkip.set(`${record.name}@${record.version}`, metadata(record));
  await publishMatchedSet({
    records,
    tagCommit,
    registryRunner: query(gitHeadSkip),
    publishRunner: publish(gitHeadSkip),
    packRunner: pack,
    sleep: async () => {},
    maxAttempts: 1,
  });
  assert.equal(gitHeadSkip.size, records.length, "verified gitHead prefix was republished");
  checks.push("verified prefix skipped by gitHead");

  const privateIntegrity = newRegistry();
  for (const record of records.slice(0, 2)) {
    privateIntegrity.set(`${record.name}@${record.version}`, metadata(record, "private"));
  }
  await publishMatchedSet({
    records,
    tagCommit,
    privateRepository: true,
    registryRunner: query(privateIntegrity),
    publishRunner: publish(privateIntegrity, { privateIntegrity: true }),
    packRunner: pack,
    sleep: async () => {},
    maxAttempts: 1,
  });
  checks.push("verified prefix skipped by private-prepared integrity");

  const integrityMismatch = newRegistry();
  integrityMismatch.set(`${records[0].name}@${records[0].version}`, metadata(records[0], "private"));
  await assert.rejects(() => publishMatchedSet({
    records,
    tagCommit,
    privateRepository: true,
    registryRunner: query(integrityMismatch),
    publishRunner: publish(integrityMismatch, { privateIntegrity: true }),
    packRunner: async () => ({ integrity: "sha512-wrong" }),
    sleep: async () => {},
    maxAttempts: 1,
  }), /integrity mismatch/);
  checks.push("private-prepared integrity mismatch rejected");

  const mismatch = newRegistry();
  mismatch.set(`${records[0].name}@${records[0].version}`, { gitHead: "other-commit" });
  await assert.rejects(
    () => publishMatchedSet({
      records,
      tagCommit,
      registryRunner: query(mismatch),
      publishRunner: publish(mismatch),
      packRunner: pack,
      sleep: async () => {},
      maxAttempts: 1,
    }),
    /gitHead/,
  );
  checks.push("mismatched pre-existing version rejected");

  const timeout = newRegistry();
  await assert.rejects(
    () => publishMatchedSet({
      records,
      tagCommit,
      registryRunner: query(timeout),
      publishRunner: async () => {},
      packRunner: pack,
      sleep: async () => {},
      maxAttempts: 2,
    }),
    /visibility timeout/,
  );
  checks.push("visibility timeout rejected");
  return { status: "PASS", selfTest: true, checks };
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  console.log(JSON.stringify(await selfTest(), null, 2));
} else {
  const tag = process.env.GITHUB_REF_NAME ?? "";
  const tagMatch = /^dcb-v(.+)$/.exec(tag);
  const records = loadReleaseRecords();
  if (!tagMatch || records.some((record) => record.version !== tagMatch[1])) {
    error(`tag ${tag} does not match all manifest versions`);
  }
  const result = await publishMatchedSet({
    records,
    tagCommit: process.env.GITHUB_SHA,
    privateRepository: process.env.PRIVATE_REPOSITORY === "true",
  });
  console.log(JSON.stringify(result, null, 2));
}

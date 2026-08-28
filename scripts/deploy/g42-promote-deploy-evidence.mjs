#!/usr/bin/env node
/**
 * Promotes the exact G42 build/deploy/read-back transcripts into normal Git
 * evidence after a code-only deployment.  The Worker bundle itself is bound
 * by its recorded SHA-256; the audit retains the emitted build metadata,
 * commands, logs, deployment records, and version read-backs without ever
 * copying a protected conformance token.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const SHA = /^[a-f0-9]{40}$/;

const ARTIFACTS = Object.freeze([
  ["commands", "-commands.txt"],
  ["dryRun", "-dry-run.log"],
  ["deploy", "-deploy.log"],
  ["deploymentsBefore", "-deployments-before.json"],
  ["deploymentsAfter", "-deployments-after.json"],
  ["versionBefore", "-version-before.json"],
  ["versionAfter", "-version-after.json"],
  ["bundleMeta", "-build/bundle-meta.json"],
  ["buildFacts", "-build-facts.json"],
  ["witness", "-witness.json"],
  ["provider", "-provider.json"],
]);

function fail(message) {
  throw new Error(`g42-promote-deploy-evidence:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function fullSha(name, value) {
  const result = required(name, value);
  if (!SHA.test(result)) fail(`${name} must be a full git SHA`);
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertNoSecret(bytes, token) {
  if (token.length > 0 && bytes.includes(token)) fail("protected conformance token occurs in a deploy transcript");
  // Evidence must never preserve an authorization header even when its value
  // has already expired. This is broader than the particular temporary token.
  if (/authorization\s*:\s*bearer\s+/i.test(bytes) || /bearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(bytes)) {
    fail("deploy transcript contains a bearer authorization value");
  }
}

function artifactSource(prefix, suffix) {
  const path = `${prefix}${suffix}`;
  if (!existsSync(path)) fail(`required artifact is absent: ${path}`);
  return path;
}

export function promoteG42DeployEvidence({ prefix, sourceCommit, outputDir, manifest, token }) {
  const source = fullSha("sourceCommit", sourceCommit);
  if (!prefix.endsWith(source.slice(0, 12))) fail("artifact prefix does not bind the source commit abbreviation");
  const targetRoot = resolve(outputDir);
  const manifestPath = resolve(manifest);
  if (existsSync(targetRoot) || existsSync(manifestPath)) fail("refusing to replace deploy audit evidence");
  const copies = [];
  for (const [kind, suffix] of ARTIFACTS) {
    const from = artifactSource(prefix, suffix);
    const bytes = readFileSync(from, "utf8");
    assertNoSecret(bytes, token);
    const relative = basename(suffix);
    const to = resolve(targetRoot, `${kind}-${relative}`);
    copies.push(Object.freeze({ kind, from, to, bytes }));
  }
  mkdirSync(targetRoot, { recursive: true });
  for (const copy of copies) copyFileSync(copy.from, copy.to);
  const document = Object.freeze({
    schema: "sdt.g42.deploy-audit/v1",
    sourceCommit: source,
    note: "Exact command/build/deploy/read-back artifacts are copied verbatim after secret scanning. The module bundle is identified by buildFacts.moduleBundleDigest; no token value is retained.",
    artifacts: Object.freeze(copies.map((copy) => Object.freeze({
      kind: copy.kind,
      path: `${outputDir.replace(/\/$/, "")}/${basename(copy.to)}`,
      byteLength: Buffer.byteLength(copy.bytes),
      sha256: sha256(copy.bytes),
    }))),
  });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

export function selfTest() {
  assertNoSecret("wrangler deploy --secrets-file [protected]", "fixture-token");
  let rejected = false;
  try { assertNoSecret("authorization: Bearer fixture-token", "fixture-token"); } catch { rejected = true; }
  if (!rejected) fail("token-bearing transcript unexpectedly passed");
  return Object.freeze({ artifactKinds: ARTIFACTS.map(([kind]) => kind), forcedRed: "token-bearing-transcript" });
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const tokenPath = required("--token-file", argument("--token-file"));
  const token = readFileSync(tokenPath, "utf8").trim();
  if (token.length === 0) fail("token file is empty");
  const outputDir = required("--output-dir", argument("--output-dir"));
  const outcome = promoteG42DeployEvidence({
    prefix: required("--prefix", argument("--prefix")),
    sourceCommit: required("--source-commit", argument("--source-commit")),
    outputDir,
    manifest: required("--manifest", argument("--manifest")),
    token,
  });
  console.log(JSON.stringify({ sourceCommit: outcome.sourceCommit, artifactCount: outcome.artifacts.length }, null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) main();

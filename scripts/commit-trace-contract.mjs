#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUTHORITY_SPECS,
  BUNDLE_REL,
  MANIFEST_REL,
  PIN_REL,
  RENDERED_REL,
  assertManifest as assertGeneratedManifest,
  checkGenerated,
  gitBlob,
  gitEnv,
  gitText,
} from "./commit-trace-generate.mjs";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FIXTURE_FILES = Object.freeze({
  githubBase: "fixtures/commit-trace-github-base.txt",
  newerBase: "fixtures/commit-trace-newer-base.txt",
  wrongSealParent: "fixtures/commit-trace-wrong-seal-parent.txt",
  wideSeal: "fixtures/commit-trace-wide-seal.txt",
});

function fail(code, message) {
  throw new Error("commit-trace-contract:" + code + ":" + message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !same([...Object.keys(value)].sort(), [...expected].sort())) {
    fail("key-set", label + " has an unexpected key set");
  }
}

function digest(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function readText(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function parseJson(root, relativePath) {
  return JSON.parse(readText(root, relativePath));
}

function assertNotShallow(root) {
  if (gitText(root, ["rev-parse", "--is-shallow-repository"]) === "true") {
    fail("shallow", "repository is shallow; checkout actions must use fetch-depth: 0");
  }
}

function strictPin(pin) {
  exactKeys(pin, ["schemaVersion", "state", "authorityCommit", "bundleDigest"], "pin");
  if (pin.schemaVersion !== 3 || !["sealed", "unsealed"].includes(pin.state) || !SHA.test(pin.authorityCommit) || !SHA256.test(pin.bundleDigest)) {
    fail("pin-shape", "pin must be a schema 3 object with valid sealed values");
  }
}

function assertSealedPin(pin) {
  if (pin.state !== "sealed") fail("pin-state", "pin must be sealed");
}

function strictBundle(bundle) {
  exactKeys(bundle, ["schemaVersion", "name", "description", "authorityFiles", "bundleDigest"], "bundle");
  if (bundle.schemaVersion !== 4 || bundle.name !== "commit-trace-bundle" || typeof bundle.description !== "string" || !Array.isArray(bundle.authorityFiles) || !SHA256.test(bundle.bundleDigest)) {
    fail("bundle-shape", "bundle must be schema 4");
  }
  for (const entry of bundle.authorityFiles) {
    exactKeys(entry, ["path", "role", "bytes", "digest"], "authority entry");
    if (typeof entry.path !== "string" || entry.path.length === 0 || !["source", "generator", "generated", "checker"].includes(entry.role) || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(entry.digest)) {
      fail("bundle-entry", "authority entry is malformed");
    }
  }
}

function assertHeadBytes(root) {
  const head = gitText(root, ["rev-parse", "HEAD"]);
  const headPin = gitBlob(root, "HEAD:" + PIN_REL);
  const headBundle = gitBlob(root, "HEAD:" + BUNDLE_REL);
  if (!headPin || !headBundle) fail("head-authority", "HEAD is missing the pin or bundle");
  if (!Buffer.from(readText(root, PIN_REL), "utf8").equals(headPin)) fail("head-pin", "working-tree pin differs from its HEAD blob");
  if (!Buffer.from(readText(root, BUNDLE_REL), "utf8").equals(headBundle)) fail("head-bundle", "working-tree bundle differs from its HEAD blob");
  return head;
}

function pinBlob(root, commit) {
  return gitBlob(root, commit + ":" + PIN_REL);
}

function commitParents(root, commit) {
  return gitText(root, ["rev-list", "--parents", "-n", "1", commit]).split(/\s+/).slice(1);
}

function changesPin(root, commit) {
  const current = pinBlob(root, commit);
  return commitParents(root, commit).every((parent) => {
    const previous = pinBlob(root, parent);
    return current === null ? previous !== null : previous === null || !current.equals(previous);
  });
}

function exactPin(pin, state, authorityCommit, bundleDigest) {
  return same(pin, { schemaVersion: 3, state, authorityCommit, bundleDigest });
}

function sealCandidates(root, authorityCommit, bundleDigest) {
  const commits = gitText(root, ["rev-list", "--ancestry-path", authorityCommit + "..HEAD"]).split(/\s+/).filter(Boolean);
  const changed = commits.filter((commit) => changesPin(root, commit));
  const candidates = changed.filter((commit) => {
    const parents = commitParents(root, commit);
    if (parents.length !== 1 || parents[0] !== authorityCommit) return false;
    const before = pinBlob(root, authorityCommit);
    const after = pinBlob(root, commit);
    if (!before || !after) return false;
    let beforePin;
    let afterPin;
    try {
      beforePin = JSON.parse(before.toString("utf8"));
      afterPin = JSON.parse(after.toString("utf8"));
    } catch {
      return false;
    }
    if (!exactPin(beforePin, "unsealed", "0".repeat(40), bundleDigest) || !exactPin(afterPin, "sealed", authorityCommit, bundleDigest)) return false;
    return same(gitText(root, ["diff", "--name-only", authorityCommit, commit]).split(/\s+/).filter(Boolean), [PIN_REL]);
  });
  return { commits, changed, candidates };
}

function assertSealTopology(root, pin, bundle) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", pin.authorityCommit, "HEAD"], {
      cwd: root,
      env: gitEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    fail("ancestor", "authorityCommit is not an ancestor of HEAD");
  }
  const topology = sealCandidates(root, pin.authorityCommit, bundle.bundleDigest);
  if (topology.candidates.length !== 1) fail("seal", "expected one A-to-S seal commit on the ancestry path");
  const S = topology.candidates[0];
  const headPin = pinBlob(root, "HEAD");
  const sealPin = pinBlob(root, S);
  if (!headPin || !sealPin || !headPin.equals(sealPin)) fail("seal", "HEAD pin differs from S pin");
  if (topology.changed.length !== 1 || topology.changed[0] !== S) fail("seal", "a commit other than S changes the pin");
  const authorityBundle = gitBlob(root, pin.authorityCommit + ":" + BUNDLE_REL);
  const headBundle = gitBlob(root, "HEAD:" + BUNDLE_REL);
  if (!authorityBundle || !headBundle || !authorityBundle.equals(headBundle)) fail("seal", "HEAD bundle differs from A bundle");
  return { A: pin.authorityCommit, S };
}

function assertListedAuthorityBytes(root, bundle, authorityCommit) {
  for (const entry of bundle.authorityFiles) {
    let working;
    try {
      working = Buffer.from(readText(root, entry.path), "utf8");
    } catch {
      fail("authority-files", entry.path + " is missing from the working tree");
    }
    const head = gitBlob(root, "HEAD:" + entry.path);
    const atA = gitBlob(root, authorityCommit + ":" + entry.path);
    if (!head || !atA || !working.equals(head) || !head.equals(atA)) fail("authority-files", entry.path + " changed after A or differs from HEAD");
    if (working.byteLength !== entry.bytes || digest(working) !== entry.digest) fail("authority-files", entry.path + " has the wrong bytes or digest");
  }
}

function assertRequiredAuthorityFiles(bundle) {
  const expected = new Map(AUTHORITY_SPECS);
  const seen = new Set();
  for (const entry of bundle.authorityFiles) {
    if (seen.has(entry.path) || !expected.has(entry.path) || expected.get(entry.path) !== entry.role) fail("authority-files", "authority path or role is unexpected");
    seen.add(entry.path);
  }
  if (seen.size !== expected.size || [...expected.keys()].some((path) => !seen.has(path))) fail("authority-files", "required authority path is missing");
}

function recomputedBundleDigest(bundle) {
  const material = ["sekiban-dcb-ts/commit-trace-bundle/v4", ...bundle.authorityFiles.map((entry) => [entry.path, entry.role, entry.bytes, entry.digest].join("\t"))].join("\n");
  return digest(Buffer.from(material, "utf8"));
}

function assertBundleDigest(bundle, pin) {
  const computed = recomputedBundleDigest(bundle);
  if (computed !== bundle.bundleDigest || computed !== pin.bundleDigest) fail("bundle-digest", "recomputed bundleDigest differs from the pin");
  return computed;
}

export function assertManifest(manifest) {
  return assertGeneratedManifest(manifest);
}

export function loadAuthority(root = process.cwd()) {
  return {
    bundle: parseJson(root, BUNDLE_REL),
    manifest: parseJson(root, MANIFEST_REL),
    pin: parseJson(root, PIN_REL),
  };
}

export function sealedAuthority(root = process.cwd()) {
  return check(root).authority;
}

export function assertTargetInvocation(argv = process.argv.slice(2)) {
  if (argv.some((value) => value === "--write" || value === "--seal")) fail("target-write-forbidden", "the verifier is read-only");
  if (argv.some((value) => value !== "--check" && value !== "--self-test")) fail("argument", "unsupported verifier argument");
}

export function check(root = process.cwd()) {
  assertNotShallow(root);
  const head = assertHeadBytes(root);
  const { bundle, manifest, pin } = loadAuthority(root);
  strictPin(pin);
  strictBundle(bundle);
  assertSealedPin(pin);
  const topology = assertSealTopology(root, pin, bundle);
  assertListedAuthorityBytes(root, bundle, pin.authorityCommit);
  const computed = assertBundleDigest(bundle, pin);
  assertRequiredAuthorityFiles(bundle);
  const structure = assertManifest(manifest);
  const generated = checkGenerated(root);
  return Object.freeze({
    mode: "check",
    head,
    authority: { A: topology.A, S: topology.S, bundleDigest: computed },
    generated,
    structure,
  });
}

const fixtureGitEnv = gitEnv({ isolateGlobal: true });

function fixtureGit(root, args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: fixtureGitEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function configureFixture(root) {
  fixtureGit(root, ["config", "user.name", "Commit Trace Self Test"]);
  fixtureGit(root, ["config", "user.email", "commit-trace-self-test@example.invalid"]);
  fixtureGit(root, ["config", "commit.gpgsign", "false"]);
  fixtureGit(root, ["config", "core.autocrlf", "false"]);
  const hooks = join(root, ".self-test-hooks");
  mkdirSync(hooks, { recursive: true });
  fixtureGit(root, ["config", "core.hooksPath", hooks]);
}

function makeFixture(sourceRoot, shallow = false) {
  const parent = mkdtempSync(join(tmpdir(), "sdt-g109-contract-"));
  const root = join(parent, "repo");
  try {
    const sourceHead = gitText(sourceRoot, ["rev-parse", "HEAD"]);
    const cloneArgs = shallow ? ["clone", "--depth", "1", "file://" + sourceRoot, root] : ["clone", sourceRoot, root];
    execFileSync("git", cloneArgs, { env: fixtureGitEnv, stdio: ["ignore", "pipe", "ignore"] });
    fixtureGit(root, ["checkout", "--detach", sourceHead]);
    configureFixture(root);
    return { root, parent };
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

function removeFixture(fixture) {
  rmSync(fixture.parent, { recursive: true, force: true });
}

function commitFixture(root, paths, message) {
  fixtureGit(root, ["add", ...paths]);
  fixtureGit(root, ["commit", "-m", message]);
}

function writeJsonFixture(root, relativePath, value, indent = 2) {
  writeFileSync(join(root, relativePath), JSON.stringify(value, null, indent) + "\n", "utf8");
}

function expectVerifierRed(root, name, expectedPrefix, detail = "") {
  try {
    execFileSync(process.execPath, [join(root, "scripts/commit-trace-contract.mjs"), "--check"], {
      cwd: root,
      env: fixtureGitEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr ?? error);
    if (!stderr.includes(expectedPrefix)) fail("self-test", `${name} failed for the wrong reason; expected ${expectedPrefix}`);
    if (detail !== "" && !stderr.includes(detail)) fail("self-test", `${name} did not report ${detail}`);
    return { name, expected: expectedPrefix };
  }
  fail("self-test", name + " mutation stayed green");
}

function mutateFixture(sourceRoot, name, expectedPrefix, mutate, detail = "") {
  const fixture = makeFixture(sourceRoot);
  try {
    mutate(fixture.root);
    return expectVerifierRed(fixture.root, name, expectedPrefix, detail);
  } finally {
    removeFixture(fixture);
  }
}

function rewriteBundleFromWorkingTree(root, mutateBundle) {
  const bundle = parseJson(root, BUNDLE_REL);
  bundle.authorityFiles = AUTHORITY_SPECS.map(([path, role]) => {
    const bytes = Buffer.from(readText(root, path), "utf8");
    return { path, role, bytes: bytes.byteLength, digest: digest(bytes) };
  });
  mutateBundle?.(bundle);
  bundle.bundleDigest = recomputedBundleDigest(bundle);
  return bundle;
}

function createManualReseal(root, changedPath, mutateBundle, suffix = "\nself-test authority mutation\n") {
  if (changedPath !== undefined) writeFileSync(join(root, changedPath), readText(root, changedPath) + suffix, "utf8");
  const bundle = rewriteBundleFromWorkingTree(root, mutateBundle);
  writeJsonFixture(root, BUNDLE_REL, bundle);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "unsealed", authorityCommit: "0".repeat(40), bundleDigest: bundle.bundleDigest });
  commitFixture(root, [changedPath, BUNDLE_REL, PIN_REL].filter(Boolean), "self-test authority A prime");
  const authorityCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit, bundleDigest: bundle.bundleDigest });
  commitFixture(root, [PIN_REL], "self-test authority S prime");
}

function createWrongDigestReseal(root) {
  const bundle = parseJson(root, BUNDLE_REL);
  bundle.bundleDigest = "sha256:" + "0".repeat(64);
  writeJsonFixture(root, BUNDLE_REL, bundle);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "unsealed", authorityCommit: "0".repeat(40), bundleDigest: bundle.bundleDigest });
  commitFixture(root, [BUNDLE_REL, PIN_REL], "self-test wrong digest A prime");
  const authorityCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit, bundleDigest: bundle.bundleDigest });
  commitFixture(root, [PIN_REL], "self-test wrong digest S prime");
}

function createListedBytesMismatchReseal(root) {
  const bundle = rewriteBundleFromWorkingTree(root, (current) => {
    const entry = current.authorityFiles.find((candidate) => candidate.path === "scripts/commit-trace-generate.mjs");
    if (entry === undefined) fail("self-test", "listed-byte mismatch fixture is missing its generator entry");
    entry.bytes += 1;
  });
  writeJsonFixture(root, BUNDLE_REL, bundle);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "unsealed", authorityCommit: "0".repeat(40), bundleDigest: bundle.bundleDigest });
  commitFixture(root, [BUNDLE_REL, PIN_REL], "self-test listed bytes A prime");
  const authorityCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit, bundleDigest: bundle.bundleDigest });
  commitFixture(root, [PIN_REL], "self-test listed bytes S prime");
}

function createListedBytesAndDigestMismatchReseal(root) {
  const bundle = rewriteBundleFromWorkingTree(root, (current) => {
    const entry = current.authorityFiles.find((candidate) => candidate.path === "scripts/commit-trace-generate.mjs");
    if (entry === undefined) fail("self-test", "listed-byte and digest mismatch fixture is missing its generator entry");
    entry.bytes += 1;
  });
  bundle.bundleDigest = "sha256:" + "0".repeat(64);
  writeJsonFixture(root, BUNDLE_REL, bundle);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "unsealed", authorityCommit: "0".repeat(40), bundleDigest: bundle.bundleDigest });
  commitFixture(root, [BUNDLE_REL, PIN_REL], "self-test listed bytes and digest A prime");
  const authorityCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit, bundleDigest: bundle.bundleDigest });
  commitFixture(root, [PIN_REL], "self-test listed bytes and digest S prime");
}

function createNonPlaceholderReseal(root) {
  const bundle = parseJson(root, BUNDLE_REL);
  const previousHead = fixtureGit(root, ["rev-parse", "HEAD"]);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "unsealed", authorityCommit: previousHead, bundleDigest: bundle.bundleDigest });
  commitFixture(root, [PIN_REL], "self-test non-placeholder A prime");
  const authorityCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit, bundleDigest: bundle.bundleDigest });
  commitFixture(root, [PIN_REL], "self-test non-placeholder S prime");
}

function mutationTests(sourceRoot) {
  const results = [];
  results.push(mutateFixture(sourceRoot, "coordinated-generator-generated-checker-drift", "commit-trace-contract:authority-files:", (root) => {
    const paths = ["scripts/commit-trace-generate.mjs", MANIFEST_REL, "scripts/commit-trace-contract.mjs"];
    for (const path of paths) writeFileSync(join(root, path), readText(root, path) + "\n", "utf8");
    commitFixture(root, paths, "self-test coordinated authority drift");
  }, "scripts/commit-trace-generate.mjs changed after A or differs from HEAD"));
  results.push(mutateFixture(sourceRoot, "listed-authority-bytes", "commit-trace-contract:authority-files:", createListedBytesMismatchReseal, "scripts/commit-trace-generate.mjs has the wrong bytes or digest"));
  results.push(mutateFixture(sourceRoot, "listed-authority-bytes-before-bundle-digest", "commit-trace-contract:authority-files:", createListedBytesAndDigestMismatchReseal, "scripts/commit-trace-generate.mjs has the wrong bytes or digest"));
  results.push(mutateFixture(sourceRoot, "wrong-pin-digest", "commit-trace-contract:bundle-digest:", createWrongDigestReseal));
  results.push(mutateFixture(sourceRoot, "exact-placeholder-pin", "commit-trace-contract:seal:", createNonPlaceholderReseal, "expected one A-to-S seal commit"));
  results.push(mutateFixture(sourceRoot, "worktree-pin-drift", "commit-trace-contract:head-pin:", (root) => {
    writeJsonFixture(root, PIN_REL, parseJson(root, PIN_REL), 4);
  }, "working-tree pin differs from its HEAD blob"));
  results.push(mutateFixture(sourceRoot, "non-ancestor-authority", "commit-trace-contract:ancestor:", (root) => {
    const sealedHead = fixtureGit(root, ["rev-parse", "HEAD"]);
    const pin = parseJson(root, PIN_REL);
    fixtureGit(root, ["checkout", "-b", "self-test-non-ancestor", pin.authorityCommit + "^"]);
    writeFileSync(join(root, FIXTURE_FILES.wrongSealParent), "non-ancestor authority\n", "utf8");
    commitFixture(root, [FIXTURE_FILES.wrongSealParent], "self-test non-ancestor fixture");
    const nonAncestor = fixtureGit(root, ["rev-parse", "HEAD"]);
    fixtureGit(root, ["checkout", "--detach", sealedHead]);
    pin.authorityCommit = nonAncestor;
    writeJsonFixture(root, PIN_REL, pin);
    commitFixture(root, [PIN_REL], "self-test non-ancestor authority");
  }, "authorityCommit is not an ancestor of HEAD"));
  results.push(mutateFixture(sourceRoot, "ancestor-authority-with-wrong-seal-parent", "commit-trace-contract:seal:", (root) => {
    const pin = parseJson(root, PIN_REL);
    fixtureGit(root, ["checkout", "--detach", pin.authorityCommit]);
    writeFileSync(join(root, FIXTURE_FILES.wrongSealParent), "wrong seal parent\n", "utf8");
    commitFixture(root, [FIXTURE_FILES.wrongSealParent], "self-test intermediate");
    fixtureGit(root, ["rm", FIXTURE_FILES.wrongSealParent]);
    writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit: pin.authorityCommit, bundleDigest: pin.bundleDigest });
    commitFixture(root, [PIN_REL], "self-test wrong seal parent");
  }, "expected one A-to-S seal commit"));
  results.push(mutateFixture(sourceRoot, "seal-changes-more-than-pin", "commit-trace-contract:seal:", (root) => {
    const pin = parseJson(root, PIN_REL);
    fixtureGit(root, ["checkout", "--detach", pin.authorityCommit]);
    writeJsonFixture(root, PIN_REL, { schemaVersion: 3, state: "sealed", authorityCommit: pin.authorityCommit, bundleDigest: pin.bundleDigest });
    writeFileSync(join(root, FIXTURE_FILES.wideSeal), "wide seal\n", "utf8");
    commitFixture(root, [PIN_REL, FIXTURE_FILES.wideSeal], "self-test wide seal");
  }, "expected one A-to-S seal commit"));
  results.push(mutateFixture(sourceRoot, "later-pin-change", "commit-trace-contract:seal:", (root) => {
    writeJsonFixture(root, PIN_REL, parseJson(root, PIN_REL), 4);
    commitFixture(root, [PIN_REL], "self-test later pin formatting");
  }, "HEAD pin differs from S pin"));
  results.push(mutateFixture(sourceRoot, "later-pin-change-reverted-at-head", "commit-trace-contract:seal:", (root) => {
    const original = readText(root, PIN_REL);
    writeJsonFixture(root, PIN_REL, parseJson(root, PIN_REL), 4);
    commitFixture(root, [PIN_REL], "self-test later pin formatting then revert");
    writeFileSync(join(root, PIN_REL), original, "utf8");
    commitFixture(root, [PIN_REL], "self-test later pin exact revert");
  }, "a commit other than S changes the pin"));
  results.push(mutateFixture(sourceRoot, "merge-pin-differs-from-both-parents", "commit-trace-contract:seal:", (root) => {
    const pin = parseJson(root, PIN_REL);
    const sealedHead = fixtureGit(root, ["rev-parse", "HEAD"]);
    const sealedPinBytes = readFileSync(join(root, PIN_REL));
    fixtureGit(root, ["checkout", "-b", "self-test-merge-x", pin.authorityCommit + "^"]);
    writeFileSync(join(root, FIXTURE_FILES.wideSeal), "merge X fixture\n", "utf8");
    commitFixture(root, [FIXTURE_FILES.wideSeal], "self-test merge X fixture");
    const x = fixtureGit(root, ["rev-parse", "HEAD"]);
    fixtureGit(root, ["checkout", "-b", "self-test-merge-y", sealedHead]);
    writeFileSync(join(root, FIXTURE_FILES.newerBase), "merge Y fixture\n", "utf8");
    commitFixture(root, [FIXTURE_FILES.newerBase], "self-test merge Y fixture");
    const y = fixtureGit(root, ["rev-parse", "HEAD"]);
    fixtureGit(root, ["checkout", "--detach", sealedHead]);
    fixtureGit(root, ["merge", "--no-ff", "--no-commit", x]);
    writeJsonFixture(root, PIN_REL, parseJson(root, PIN_REL), 4);
    commitFixture(root, [PIN_REL, FIXTURE_FILES.wideSeal], "self-test merge M");
    const mergeM = fixtureGit(root, ["rev-parse", "HEAD"]);
    const mergeParents = commitParents(root, mergeM);
    const mergePin = pinBlob(root, mergeM);
    if (mergeParents.length !== 2 || mergePin === null || mergeParents.some((parent) => {
      const parentPin = pinBlob(root, parent);
      return parentPin !== null && parentPin.equals(mergePin);
    })) fail("self-test", "merge M does not have two parents with a distinct pin blob");
    fixtureGit(root, ["merge", "--no-ff", "--no-commit", y]);
    writeFileSync(join(root, PIN_REL), sealedPinBytes);
    commitFixture(root, [PIN_REL, FIXTURE_FILES.newerBase], "self-test merge N");
    const headPin = pinBlob(root, "HEAD");
    const sealedPin = pinBlob(root, sealedHead);
    if (headPin === null || sealedPin === null || !headPin.equals(sealedPin)) fail("self-test", "merge N does not restore the S pin bytes");
  }, "a commit other than S changes the pin"));
  results.push(mutateFixture(sourceRoot, "head-bundle-drops-entry", "commit-trace-contract:seal:", (root) => {
    const bundle = parseJson(root, BUNDLE_REL);
    bundle.authorityFiles.pop();
    writeJsonFixture(root, BUNDLE_REL, bundle);
    commitFixture(root, [BUNDLE_REL], "self-test post-S bundle drift");
  }, "HEAD bundle differs from A bundle"));
  results.push(mutateFixture(sourceRoot, "resealed-bundle-drops-entry", "commit-trace-contract:authority-files:", (root) => {
    createManualReseal(root, undefined, (bundle) => bundle.authorityFiles.pop());
  }, "required authority path is missing"));
  results.push(mutateFixture(sourceRoot, "source-change-resealed-without-regeneration", "commit-trace-generate:", (root) => {
    createManualReseal(root, "contracts/commit-trace-normative.md", undefined, "\n- epoch source mutation\n");
  }, "unclassified naked epoch"));
  results.push(mutateFixture(sourceRoot, "generated-only-change-resealed", "commit-trace-generate:", (root) => {
    createManualReseal(root, RENDERED_REL, undefined, "\ngenerated mutation\n");
  }, RENDERED_REL + " differs from generated output"));
  const shallow = makeFixture(sourceRoot, true);
  try {
    results.push(expectVerifierRed(shallow.root, "shallow-clone", "commit-trace-contract:shallow:", "fetch-depth: 0"));
  } finally {
    removeFixture(shallow);
  }
  return results;
}

function mergeSuccessTests(sourceRoot) {
  const results = [];
  const github = makeFixture(sourceRoot);
  try {
    const pin = parseJson(github.root, PIN_REL);
    fixtureGit(github.root, ["branch", "self-test-sealed-side", "HEAD"]);
    fixtureGit(github.root, ["checkout", "-b", "self-test-base", pin.authorityCommit + "^"]);
    writeFileSync(join(github.root, FIXTURE_FILES.githubBase), "github-shaped base\n", "utf8");
    commitFixture(github.root, [FIXTURE_FILES.githubBase], "self-test base");
    fixtureGit(github.root, ["merge", "--no-ff", "self-test-sealed-side", "-m", "self-test GitHub merge"]);
    check(github.root);
    results.push("github-shaped-merge");
  } finally {
    removeFixture(github);
  }

  const newer = makeFixture(sourceRoot);
  try {
    const pin = parseJson(newer.root, PIN_REL);
    const sealedHead = gitText(newer.root, ["rev-parse", "HEAD"]);
    fixtureGit(newer.root, ["checkout", "-b", "self-test-newer-base", pin.authorityCommit + "^"]);
    writeFileSync(join(newer.root, FIXTURE_FILES.newerBase), "newer base\n", "utf8");
    commitFixture(newer.root, [FIXTURE_FILES.newerBase], "self-test newer base");
    fixtureGit(newer.root, ["checkout", "-b", "self-test-descendant", sealedHead]);
    fixtureGit(newer.root, ["merge", "--no-ff", "self-test-newer-base", "-m", "self-test descendant merge"]);
    check(newer.root);
    results.push("newer-base-merge");
  } finally {
    removeFixture(newer);
  }
  return results;
}

function expectManifestRed(baseline, name, mutate, expectedFragment) {
  const altered = structuredClone(baseline);
  mutate(altered);
  try {
    assertManifest(altered);
  } catch (error) {
    if (expectedFragment !== "" && !String(error).includes(expectedFragment)) fail("self-test", `${name} failed for the wrong manifest reason`);
    return name;
  }
  fail("self-test", name + " mutation stayed green");
}

function inMemoryManifestMutations(manifest, root) {
  const names = [];
  names.push(expectManifestRed(manifest, "matrix-row-delete", (altered) => {
    delete altered.attributeMatrix.attributes.colo;
  }, "attribute identity"));
  names.push(expectManifestRed(manifest, "canonical-row-delete", (altered) => {
    altered.schemas["sdt.commit/v1"].rows = altered.schemas["sdt.commit/v1"].rows.filter((row) => row.rowId !== "S14");
  }, "v1 row/universe partition"));
  names.push(expectManifestRed(manifest, "boundary-overlap", (altered) => {
    altered.schemas["sdt.commit/v1"].boundaries[0].forbiddenRows.push("S00");
  }, "boundary has overlapping row sets"));
  names.push(expectManifestRed(manifest, "parent-self", (altered) => {
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S01").logicalParent = "S01";
  }, "is its own parent"));
  names.push(expectManifestRed(manifest, "logical-parent-reversal", (altered) => {
    const stage = altered.schemas["sdt.commit.reconcile/v1"].rows.find((row) => row.rowId === "R03");
    const member = altered.schemas["sdt.commit.reconcile/v1"].rows.find((row) => row.rowId === "R04");
    stage.logicalParent = "R04";
    member.logicalParent = "R00";
  }, "manifest-authority"));
  names.push(expectManifestRed(manifest, "emitter-swap", (altered) => {
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S02").emitter = "root-worker";
  }, "manifest-authority"));
  names.push(expectManifestRed(manifest, "start-point", (altered) => {
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S01").start = "after request.json";
  }, "manifest-authority"));
  names.push(expectManifestRed(manifest, "end-point", (altered) => {
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S01").end = "response complete";
  }, "manifest-authority"));
  names.push(expectManifestRed(manifest, "cardinality-minus", (altered) => {
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S07").successCardinality = "0";
  }, "manifest-authority"));
  names.push(expectManifestRed(manifest, "cardinality-plus", (altered) => {
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S07").successCardinality = "N+1";
  }, "manifest-authority"));
  names.push(expectManifestRed(manifest, "provider-required", (altered) => {
    altered.attributeMatrix.attributes.colo.faces.accepted = "required";
  }, "provider field is required"));
  names.push(expectManifestRed(manifest, "row-scope-empty", (altered) => {
    altered.attributeMatrix.attributes["phase.ordinal"].rowScope = [];
  }, "rowScope is empty"));
  names.push(expectManifestRed(manifest, "row-scope-unknown", (altered) => {
    altered.attributeMatrix.attributes["phase.ordinal"].rowScope.push("UNKNOWN");
  }, "rowScope names an unknown row"));
  names.push(expectManifestRed(manifest, "fact-derived-root", (altered) => {
    altered.attributeMatrix.attributes["tag.key_hash"].factDerived = true;
  }, "fact-derived scope is not rooted"));
  names.push(expectManifestRed(manifest, "recovery-kind-scope", (altered) => {
    altered.attributeMatrix.attributes["recovery.kind"].rowScope = ["R00", "R01"];
  }, "fact-derived scope is not rooted"));
  names.push(expectManifestRed(manifest, "sequential-row-kind", (altered) => {
    altered.attributeMatrix.attributes["span.kind"].values = altered.attributeMatrix.attributes["span.kind"].values.filter((value) => value !== "sequential-stage");
  }, "span.kind misses a row kind"));
  names.push(expectManifestRed(manifest, "ghost-row-kind", (altered) => {
    altered.attributeMatrix.attributes["span.kind"].values.push("ghost-kind");
  }, "span.kind contains an unused kind"));
  names.push(expectManifestRed(manifest, "member-scope-missing", (altered) => {
    altered.attributeMatrix.attributes["member.index"].rowScope = altered.attributeMatrix.attributes["member.index"].rowScope.filter((row) => row !== "S14");
  }, "member.index misses a member row"));
  names.push(expectManifestRed(manifest, "member-scope-nonmember", (altered) => {
    altered.attributeMatrix.attributes["tag.key_hash"].rowScope.push("S00");
  }, "tag.key_hash includes a non-member row"));
  names.push(expectManifestRed(manifest, "recovery-terminating-tail", (altered) => {
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["post-allocation-full-write"].transitions.pop();
  }, "terminating branch does not end at terminal"));
  names.push(expectManifestRed(manifest, "recovery-nonterminating-tail", (altered) => {
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"].transitions.push("terminal");
  }, "non-terminating branch is invalid"));
  names.push(expectManifestRed(manifest, "recovery-nonterminating-outcome", (altered) => {
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"].terminalOutcome = "ALLOCATED";
  }, "non-terminating branch is invalid"));
  names.push(expectManifestRed(manifest, "recovery-nonterminating-r06", (altered) => {
    const branch = altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"];
    branch.forbiddenRows = branch.forbiddenRows.filter((row) => row !== "R06");
    branch.requiredRows.push("R06");
  }, "non-terminating branch is invalid"));
  const alteredBundle = structuredClone(parseJson(root, BUNDLE_REL));
  alteredBundle.bundleDigest = "sha256:" + "0".repeat(64);
  try {
    strictBundle(alteredBundle);
    assertBundleDigest(alteredBundle, parseJson(root, PIN_REL));
  } catch (error) {
    if (!String(error).includes("commit-trace-contract:bundle-digest:")) fail("self-test", "bundle-drift failed for the wrong reason");
    names.push("bundle-drift");
  }
  if (!names.includes("bundle-drift")) fail("self-test", "bundle-drift mutation stayed green");
  return names;
}

export function selfTest(root = process.cwd()) {
  assertTargetInvocation(["--self-test"]);
  const authority = loadAuthority(root);
  assertManifest(authority.manifest);
  const inMemoryMutations = inMemoryManifestMutations(authority.manifest, root);
  for (const flag of ["--write", "--seal"]) {
    try {
      assertTargetInvocation([flag]);
    } catch (error) {
      if (!String(error).includes("commit-trace-contract:target-write-forbidden:")) fail("self-test", `target ${flag} rejection failed for the wrong reason`);
      continue;
    }
    fail("self-test", `target ${flag} rejection stayed green`);
  }
  const gitMutations = [];
  const successes = [];
  let gitStatus;
  if (authority.pin.state === "sealed") {
    check(root);
    gitMutations.push(...mutationTests(root));
    successes.push(...mergeSuccessTests(root));
    if (gitMutations.length !== 17 || successes.length !== 2) fail("self-test", "sealed-tree git mutation suite did not run completely");
    gitStatus = "ran-on-sealed-tree";
  } else {
    gitStatus = "skipped because the pin is unsealed";
  }
  return {
    schema: "commit-trace-contract/v4",
    passed: true,
    inMemoryMutations: ["target-write", "target-seal", ...inMemoryMutations],
    gitMutations,
    gitStatus,
    successes,
  };
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  assertTargetInvocation();
  console.log(JSON.stringify(check(), null, 2));
}

if (import.meta.url === "file://" + process.argv[1]) main();

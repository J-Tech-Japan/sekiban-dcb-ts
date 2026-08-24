#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertB0Evidence } from "./g30-b0-contract.mjs";
import { digestAtCommit as deploymentConfigDigest } from "./deploy/g30-config-digest.mjs";

const root = process.cwd();
const manifestPath = resolve(root, "docs/SDT-G30-required-roots.json");
const evidencePath = resolve(root, "docs/SDT-G30-b0-evidence.json");
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST_ALGORITHM = "sha256(path NUL content NUL, paths sorted)";
const REQUIRED_R_FILES = new Set([
  ".github/workflows/ci.yml",
  "docs/SDT-G30-b0-evidence.json",
  "docs/SDT-G30-b0-evidence.md",
]);

/**
 * Evidence is deliberately allowed to retain raw phase ledgers plus the
 * trace/structured-observation export alongside the derived summary. The
 * glob is the contract from #70; operational code is never an admissible
 * post-candidate change.
 */
function isAllowedPostCandidatePath(path) {
  return path === ".github/workflows/ci.yml" || /^docs\/SDT-G30-.*evidence.*\.(?:json|md)$/.test(path);
}

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rootCovers(rootPath, path) {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function pathsInTree() {
  return [...new Set([
    ...String(git(["ls-files"])).split(/\r?\n/),
    ...String(git(["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/),
  ].map((path) => path.trim()).filter(Boolean))];
}

export function loadManifest(read = (path) => readFileSync(path, "utf8")) {
  const manifest = JSON.parse(read(manifestPath));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.runtimeRoots) || !Array.isArray(manifest.configurationRoots) || !Array.isArray(manifest.requiredRoots)) {
    throw new Error("G30 required-root manifest is invalid");
  }
  const roots = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  if (roots.some((path) => typeof path !== "string" || path.length === 0) || new Set(roots).size !== roots.length) throw new Error("G30 declared root set is invalid");
  if (manifest.requiredRoots.some((entry) => typeof entry?.rootId !== "string" || typeof entry?.path !== "string" || !["file", "directory"].includes(entry.kind))) {
    throw new Error("G30 required-root entry is invalid");
  }
  if (Object.hasOwn(manifest, "postCandidateOperationalRecoveryPaths")) throw new Error("G30 final C/R manifest cannot self-authorize post-candidate changes");
  return manifest;
}

export function assertRoots(manifest, paths = pathsInTree()) {
  for (const rootPath of [...manifest.runtimeRoots, ...manifest.configurationRoots]) {
    if (!paths.some((path) => rootCovers(rootPath, path))) throw new Error(`G30 declared root missing: ${rootPath}`);
  }
  for (const entry of manifest.requiredRoots) {
    if (entry.kind === "file" && !paths.includes(entry.path)) throw new Error(`G30 required root missing file: ${entry.rootId}`);
    if (entry.kind === "directory" && !paths.some((path) => path.startsWith(`${entry.path}/`))) throw new Error(`G30 required root empty directory: ${entry.rootId}`);
  }
  return { declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length, requiredRoots: manifest.requiredRoots.length };
}

export function digestAtCommit(commit, roots, run = (args) => git(args, null)) {
  const entries = run(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots]).toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G30 digest root resolved no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(run(["show", `${commit}:${path}`])); hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertCandidateMaterialCoverage(candidate, manifest, run = (args) => git(args)) {
  if (!SHA.test(candidate)) throw new Error("G30 candidate must be a full SHA");
  const parent = String(run(["rev-parse", `${candidate}^`])).trim();
  const changed = String(run(["diff", "--name-only", `${parent}..${candidate}`])).split(/\r?\n/).filter(Boolean);
  if (changed.length === 0) throw new Error("G30 candidate has no material changes");
  const roots = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  const uncovered = changed.filter((path) => !roots.some((rootPath) => rootCovers(rootPath, path)));
  if (uncovered.length > 0) throw new Error(`G30 candidate contains material outside required roots: ${uncovered.join(",")}`);
  return { candidate, parent, materialPaths: changed.length };
}

function assertAuthority(evidence) {
  const pin = readJson(resolve(root, "contracts/host-pin.json"));
  const bundle = readJson(resolve(root, "contracts/commit-trace-bundle.json"));
  if (
    evidence?.authority?.A !== pin.hostCommit || evidence?.authority?.S !== "0632c3ed01449efc33eb6afcbb06854ee5a9b862" ||
    evidence?.authority?.P !== "794e31b594f70de2ea346f43c9baca48e58a6738" || evidence?.authority?.bundleDigest !== bundle.bundleDigest
  ) throw new Error("G30 evidence does not bind the sealed host A/S/P/bundle authority");
}

export function assertEvidence(evidence, manifest) {
  if (evidence?.task !== "SDT-G30" || evidence?.baseline !== "B0" || evidence?.purpose !== "attribution-only-not-g37-denominator") {
    throw new Error("G30 evidence identity is invalid");
  }
  const candidate = evidence.candidateCommit;
  if (candidate === "CANDIDATE") {
    if (evidence.sourceCommit !== candidate || evidence.deployedRuntimeCommit !== candidate || evidence?.recording?.candidateIndependent !== true || evidence?.protocol?.selfReference !== false) {
      throw new Error("G30 placeholder evidence is not a valid non-self-referential plan");
    }
    return { candidate, completed: false };
  }
  if (!SHA.test(candidate) || evidence.sourceCommit !== candidate || evidence.deployedRuntimeCommit !== candidate) throw new Error("G30 evidence source/deployed identity is invalid");
  assertAuthority(evidence);
  if (evidence?.treeDigests?.algorithm !== DIGEST_ALGORITHM || !same(evidence.treeDigests.runtimeRoots, manifest.runtimeRoots) || !same(evidence.treeDigests.configurationRoots, manifest.configurationRoots)) {
    throw new Error("G30 evidence tree roots are invalid");
  }
  for (const part of ["runtime", "configuration"]) if (!SHA256.test(evidence.treeDigests?.[part] ?? "")) throw new Error(`G30 evidence ${part} digest is invalid`);
  if (digestAtCommit(candidate, manifest.runtimeRoots) !== evidence.treeDigests.runtime || digestAtCommit(candidate, manifest.configurationRoots) !== evidence.treeDigests.configuration) {
    throw new Error("G30 candidate tree digest mismatch");
  }
  if (deploymentConfigDigest(candidate) !== evidence?.deploymentConfig?.digest) throw new Error("G30 deployment config digest mismatch");
  assertB0Evidence(evidence);
  return { candidate, completed: true };
}

export function assertPostCandidate(candidate, paths, run = (args) => git(args, "utf8")) {
  if (paths.some((path) => !isAllowedPostCandidatePath(path))) throw new Error(`G30 post-C path is not allowlisted: ${paths.filter((path) => !isAllowedPostCandidatePath(path)).join(",")}`);
  if ([...REQUIRED_R_FILES].some((path) => !paths.includes(path))) {
    throw new Error("G30 R must contain both evidence files and the retained candidate append");
  }
  const diff = String(run(["diff", "--unified=0", `${candidate}..HEAD`, "--", ".github/workflows/ci.yml"]));
  const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== candidate) throw new Error("G30 retained candidate must be exactly one append");
  return { retainedCandidate: candidate };
}

export function selfTest() {
  const manifest = loadManifest();
  // Use the actual repository inventory so directory roots are represented by
  // their files rather than by a fictional directory entry.
  const paths = pathsInTree();
  assertRoots(manifest, paths);
  let missingRed = false;
  try { assertRoots(manifest, paths.filter((path) => path !== "test/g30-b0.spec.ts")); } catch (error) { missingRed = String(error).includes("g30-b0.spec.ts"); }
  if (!missingRed) throw new Error("G30 required-root deletion mutation unexpectedly passed");
  let placeholderRed = false;
  try { assertEvidence({ task: "SDT-G30", baseline: "B0", purpose: "attribution-only-not-g37-denominator", candidateCommit: "CANDIDATE", sourceCommit: "wrong", deployedRuntimeCommit: "CANDIDATE", recording: { candidateIndependent: true }, protocol: { selfReference: false } }, manifest); } catch (error) { placeholderRed = String(error).includes("placeholder"); }
  if (!placeholderRed) throw new Error("G30 placeholder candidate mutation unexpectedly passed");
  const candidate = "a".repeat(40);
  assertPostCandidate(candidate, [".github/workflows/ci.yml", "docs/SDT-G30-b0-evidence.json", "docs/SDT-G30-b0-evidence.md", "docs/SDT-G30-B0-evidence-B-traces.json"], () => `+${candidate}\n`);
  let postRed = false;
  try { assertPostCandidate(candidate, [".github/workflows/ci.yml", "docs/SDT-G30-b0-evidence.json", "scripts/deploy/g30-b0-deploy.sh"], () => `+${candidate}\n`); } catch (error) { postRed = String(error).includes("not allowlisted"); }
  if (!postRed) throw new Error("G30 post-C operational edit mutation unexpectedly passed");
  return { requiredRoots: manifest.requiredRoots.length, mutations: ["missing-root", "placeholder-source", "post-c-operational-edit", "retained-candidate"] };
}

function main() {
  if (process.env.SDT_G30_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G30 candidate gate forced failure");
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const manifest = loadManifest();
  const evidence = readJson(evidencePath);
  const roots = assertRoots(manifest);
  const proof = assertEvidence(evidence, manifest);
  const requestedCandidate = argument("--candidate");
  if (requestedCandidate !== undefined) assertCandidateMaterialCoverage(requestedCandidate, manifest);
  if (proof.candidate !== "CANDIDATE") {
    try { execFileSync("git", ["merge-base", "--is-ancestor", proof.candidate, "HEAD"], { cwd: root }); } catch { throw new Error("G30 candidate is not an ancestor of HEAD"); }
    const paths = String(git(["diff", "--name-only", `${proof.candidate}..HEAD`])).split(/\r?\n/).filter(Boolean);
    console.log(JSON.stringify({ roots, proof, postCandidate: assertPostCandidate(proof.candidate, paths) }, null, 2));
    return;
  }
  console.log(JSON.stringify({ roots, proof }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = process.cwd();
const manifestPath = resolve(root, "docs/SDT-G29-required-roots.json");
const evidencePath = resolve(root, "docs/SDT-G29-deploy-evidence.json");
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const SDT_G29_UNBLOCK_2_RECOVERY_PATHS = Object.freeze([
  "docs/SDT-G29-oracle-map.md",
  "docs/SDT-G29-pr-body.md",
  "docs/SDT-G29-required-roots.json",
  "samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc",
  "scripts/deploy/g29-deploy-witness.sh",
  "scripts/deploy/g29-record-evidence.mjs",
  "scripts/deploy/g29-receiver-consumer-topology.mjs",
  "scripts/deploy/g29-witness.mjs",
  "scripts/deploy/g29-witness.d.mts",
  "scripts/deploy/g29-measure.mjs",
  "scripts/deploy/g29-measure.d.mts",
  "scripts/g20-candidate-check.mjs",
  "scripts/g29-candidate-check.mjs",
  "test/g29-witness.spec.ts",
]);

export function assertUnblock2RecoveryManifest(paths) {
  if (JSON.stringify(paths) !== JSON.stringify(SDT_G29_UNBLOCK_2_RECOVERY_PATHS)) {
    throw new Error("G29 post-C operational recovery manifest does not equal the SDT-G29-UNBLOCK-2 fixed allowlist");
  }
  return { operationalRecoveryPaths: paths.length };
}

export function loadManifest(read = (path) => readFileSync(path, "utf8")) {
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.runtimeRoots) || !Array.isArray(manifest.configurationRoots) || !Array.isArray(manifest.requiredRoots)) throw new Error("G29 required-root manifest schema invalid");
  if (manifest.requiredRoots.some((entry) => typeof entry?.rootId !== "string" || typeof entry.path !== "string" || (entry.kind !== "file" && entry.kind !== "directory"))) throw new Error("G29 required-root entry invalid");
  if (!Array.isArray(manifest.postCandidateOperationalRecoveryPaths) || manifest.postCandidateOperationalRecoveryPaths.some((path) => typeof path !== "string" || path.length === 0)) throw new Error("G29 post-C operational recovery manifest invalid");
  assertUnblock2RecoveryManifest(manifest.postCandidateOperationalRecoveryPaths);
  return manifest;
}

function treePaths(run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  return run(["ls-files"]).split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

export function assertDeclaredRoots(manifest, paths = treePaths()) {
  for (const rootPath of [...manifest.runtimeRoots, ...manifest.configurationRoots]) {
    const present = paths.includes(rootPath) || paths.some((path) => path.startsWith(`${rootPath}/`));
    if (!present) throw new Error(`declared-root:${rootPath}:missing`);
  }
  return { declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length };
}

export function assertRequiredRoots(manifest, paths = treePaths()) {
  for (const entry of manifest.requiredRoots) {
    if (entry.kind === "file" && !paths.includes(entry.path)) throw new Error(`${entry.rootId}:${entry.path}:missing-file`);
    if (entry.kind === "directory" && !paths.some((path) => path.startsWith(`${entry.path}/`))) throw new Error(`${entry.rootId}:${entry.path}:empty-directory`);
  }
  return { requiredRoots: manifest.requiredRoots.length };
}

function digestAtCommit(commit, roots, run = (args) => execFileSync("git", args, { cwd: root, encoding: null })) {
  const entries = run(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots]).toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of entries) { hash.update(path); hash.update("\0"); hash.update(run(["show", `${commit}:${path}`])); hash.update("\0"); }
  return hash.digest("hex");
}

export function assertEvidence(evidence, manifest) {
  if (typeof evidence?.candidateCommit !== "string" || (evidence.candidateCommit !== "CANDIDATE" && !SHA.test(evidence.candidateCommit))) throw new Error("G29 evidence candidateCommit invalid");
  if (evidence.candidateCommit !== "CANDIDATE" && evidence.sourceCommit !== evidence.candidateCommit) throw new Error("G29 evidence sourceCommit must equal candidateCommit");
  if (evidence.treeDigests?.algorithm !== "sha256(path NUL content NUL, paths sorted)") throw new Error("G29 evidence digest algorithm invalid");
  if (JSON.stringify(evidence.treeDigests.runtimeRoots) !== JSON.stringify(manifest.runtimeRoots) || JSON.stringify(evidence.treeDigests.configurationRoots) !== JSON.stringify(manifest.configurationRoots)) throw new Error("G29 evidence roots do not equal required-root manifest");
  if (!SHA256.test(evidence.treeDigests.runtime) || !SHA256.test(evidence.treeDigests.configuration)) throw new Error("G29 evidence digest invalid");
  if (evidence.candidateCommit !== "CANDIDATE") {
    const runtime = digestAtCommit(evidence.candidateCommit, manifest.runtimeRoots);
    const configuration = digestAtCommit(evidence.candidateCommit, manifest.configurationRoots);
    if (runtime !== evidence.treeDigests.runtime || configuration !== evidence.treeDigests.configuration) throw new Error("G29 candidate tree digest mismatch");
  }
  return { candidateCommit: evidence.candidateCommit, digestChecked: evidence.candidateCommit !== "CANDIDATE" };
}

export function assertFinalDeploymentIdentity(evidence) {
  if (evidence?.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  if (evidence?.candidateImpact?.deploymentRequired === false) throw new Error("G29 final candidate cannot declare deploymentRequired:false");
  if (evidence?.remoteDeployment?.deployedRuntimeCommit !== evidence?.sourceCommit) throw new Error("G29 final witness deployedRuntimeCommit must equal sourceCommit");
  return { checked: true, sourceCommit: evidence.sourceCommit };
}

export function assertPostCandidatePaths(paths, evidenceCommit, recoveryPaths = SDT_G29_UNBLOCK_2_RECOVERY_PATHS, run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  assertUnblock2RecoveryManifest(recoveryPaths);
  if (evidenceCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const supported = new Set([".github/workflows/ci.yml", "docs/SDT-G29-deploy-evidence.json", ...recoveryPaths]);
  const unsupported = paths.filter((path) => !supported.has(path));
  if (unsupported.length > 0) throw new Error(`G29 post-candidate paths not allowlisted: ${unsupported.join(",")}`);
  if (paths.includes(".github/workflows/ci.yml")) {
    const diff = run(["diff", "--unified=0", `${evidenceCommit}..HEAD`, "--", ".github/workflows/ci.yml"]);
    const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
    if (removals.length > 0 || additions.length !== 1 || additions[0].slice(1).trim() !== evidenceCommit) throw new Error("G29 retained-candidate list must append exactly the candidate");
  }
  return { checked: true };
}

export function runSelfTest() {
  const manifest = loadManifest();
  const paths = [...new Set([
    ...manifest.runtimeRoots,
    ...manifest.configurationRoots.map((path) => path.includes(".") ? path : `${path}/placeholder`),
    ...manifest.requiredRoots.map((entry) => entry.path),
    "samples/meeting-room/src/domain.ts",
    "samples/meeting-room/public/index.html",
  ])];
  assertDeclaredRoots(manifest, paths);
  assertRequiredRoots(manifest, paths);
  let missingFailed = false;
  try { assertRequiredRoots(manifest, paths.filter((path) => path !== "test/g29-mapping.spec.ts")); } catch (error) { missingFailed = String(error).includes("mapping-fixture:test/g29-mapping.spec.ts:missing-file"); }
  if (!missingFailed) throw new Error("G29 missing-root mutation did not fail");
  let emptyFailed = false;
  try { assertRequiredRoots(manifest, paths.filter((path) => !path.startsWith("samples/meeting-room/src/"))); } catch (error) { emptyFailed = String(error).includes("domain-source:samples/meeting-room/src:empty-directory"); }
  if (!emptyFailed) throw new Error("G29 empty-directory mutation did not fail");
  let declaredFailed = false;
  try { assertDeclaredRoots(manifest, paths.filter((path) => path !== "README.md")); } catch (error) { declaredFailed = String(error).includes("declared-root:README.md:missing"); }
  if (!declaredFailed) throw new Error("G29 declared-root mutation did not fail");
  const commit = "c".repeat(40);
  const final = { candidateCommit: commit, sourceCommit: commit, candidateImpact: { deploymentRequired: true }, remoteDeployment: { deployedRuntimeCommit: commit } };
  assertFinalDeploymentIdentity(final);
  let deploymentIdentityFailed = false;
  try { assertFinalDeploymentIdentity({ ...final, remoteDeployment: { deployedRuntimeCommit: "d".repeat(40) } }); } catch (error) { deploymentIdentityFailed = String(error).includes("deployedRuntimeCommit"); }
  if (!deploymentIdentityFailed) throw new Error("G29 deployed/source commit mutation did not fail");
  let deploymentRequiredFailed = false;
  try { assertFinalDeploymentIdentity({ ...final, candidateImpact: { deploymentRequired: false } }); } catch (error) { deploymentRequiredFailed = String(error).includes("deploymentRequired:false"); }
  if (!deploymentRequiredFailed) throw new Error("G29 deploymentRequired mutation did not fail");
  let recoveryAllowlistFailed = false;
  try { assertPostCandidatePaths(["packages/dcb-runtime/src/unrelated.ts"], commit, manifest.postCandidateOperationalRecoveryPaths); } catch (error) { recoveryAllowlistFailed = String(error).includes("post-candidate paths not allowlisted"); }
  if (!recoveryAllowlistFailed) throw new Error("G29 post-C recovery allowlist mutation did not fail");
  let recoveryExpansionFailed = false;
  try { assertUnblock2RecoveryManifest([...manifest.postCandidateOperationalRecoveryPaths, "packages/dcb-runtime/src/unrelated.ts"]); } catch (error) { recoveryExpansionFailed = String(error).includes("fixed allowlist"); }
  if (!recoveryExpansionFailed) throw new Error("G29 post-C recovery allowlist expansion mutation did not fail");
  return { requiredRoots: manifest.requiredRoots.length, declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length, mutations: ["missing-file", "empty-directory", "declared-root-removal", "deployment-identity", "deployment-required", "recovery-allowlist", "recovery-allowlist-expansion"] };
}

function main() {
  if (process.env.SDT_G29_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G29 candidate gate forced failure");
  if (process.argv.includes("--self-test")) { console.log(JSON.stringify(runSelfTest(), null, 2)); return; }
  const manifest = loadManifest();
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assertDeclaredRoots(manifest);
  assertRequiredRoots(manifest);
  const proof = assertEvidence(evidence, manifest);
  const deployment = assertFinalDeploymentIdentity(evidence);
  const candidate = evidence.candidateCommit;
  const active = candidate !== "CANDIDATE" && SHA.test(candidate) && (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", candidate, "HEAD"], { cwd: root }); return true; } catch { return false; } })();
  const paths = active ? execFileSync("git", ["diff", "--name-only", `${candidate}..HEAD`], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean) : [];
  const post = assertPostCandidatePaths(paths, candidate, manifest.postCandidateOperationalRecoveryPaths);
  console.log(JSON.stringify({ ...proof, deployment, manifest: { ...assertDeclaredRoots(manifest), ...assertRequiredRoots(manifest) }, postCandidate: post }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

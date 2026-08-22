#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const manifestPath = resolve(root, "docs/SDT-G31-required-roots.json");
const evidencePath = resolve(root, "docs/SDT-G31-deploy-evidence.json");
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRIOR_G31_CANDIDATE = "87da1e97bc6ada9c89f9cf490d7aa6b201d94f1c";
const PRIOR_G31_EVIDENCE_COMMIT = "dae254c1c4311e185cdfd62570a00efb6d3fd83a";

export function loadManifest(read = (path) => readFileSync(path, "utf8")) {
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.runtimeRoots) || !Array.isArray(manifest.configurationRoots) || !Array.isArray(manifest.requiredRoots)) {
    throw new Error("G31 required-root manifest schema invalid");
  }
  if (manifest.requiredRoots.some((entry) => typeof entry?.rootId !== "string" || typeof entry.path !== "string" || (entry.kind !== "file" && entry.kind !== "directory"))) {
    throw new Error("G31 required-root entry invalid");
  }
  if (Object.hasOwn(manifest, "postCandidateOperationalRecoveryPaths")) {
    throw new Error("G31 final C/R manifest must not self-authorize post-candidate operational recovery paths");
  }
  return manifest;
}

function treePaths(run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  return [...new Set([
    ...run(["ls-files"]).split(/\r?\n/),
    ...run(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/),
  ].map((path) => path.trim()).filter(Boolean))];
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
  for (const path of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(run(["show", `${commit}:${path}`]));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertEvidenceHistory(evidence) {
  if (!Array.isArray(evidence?.history) || evidence.history.length === 0) {
    throw new Error("G31 evidence must retain at least one prior C/R history entry");
  }
  for (const entry of evidence.history) {
    if (!SHA.test(entry?.candidateCommit) || entry.sourceCommit !== entry.candidateCommit || !SHA.test(entry?.evidenceCommit)) {
      throw new Error("G31 historical C/R identity is invalid");
    }
    if (entry.evidencePath !== "docs/SDT-G31-deploy-evidence.json") {
      throw new Error("G31 historical evidence path is invalid");
    }
    if (entry.deployedRuntimeCommit !== entry.candidateCommit) {
      throw new Error("G31 historical deployed runtime identity is invalid");
    }
  }
  if (!evidence.history.some((entry) =>
    entry.candidateCommit === PRIOR_G31_CANDIDATE &&
    entry.evidenceCommit === PRIOR_G31_EVIDENCE_COMMIT,
  )) {
    throw new Error("G31 prior witnessed C/R history is missing");
  }
  return { historyEntries: evidence.history.length };
}

export function assertEvidence(evidence, manifest) {
  if (typeof evidence?.candidateCommit !== "string" || (evidence.candidateCommit !== "CANDIDATE" && !SHA.test(evidence.candidateCommit))) {
    throw new Error("G31 evidence candidateCommit invalid");
  }
  if (evidence.candidateCommit !== "CANDIDATE" && evidence.sourceCommit !== evidence.candidateCommit) {
    throw new Error("G31 evidence sourceCommit must equal candidateCommit");
  }
  if (evidence.treeDigests?.algorithm !== "sha256(path NUL content NUL, paths sorted)") throw new Error("G31 evidence digest algorithm invalid");
  if (JSON.stringify(evidence.treeDigests?.runtimeRoots) !== JSON.stringify(manifest.runtimeRoots) || JSON.stringify(evidence.treeDigests?.configurationRoots) !== JSON.stringify(manifest.configurationRoots)) {
    throw new Error("G31 evidence roots do not equal required-root manifest");
  }
  if (!SHA256.test(evidence.treeDigests?.runtime) || !SHA256.test(evidence.treeDigests?.configuration)) throw new Error("G31 evidence digest invalid");
  if (evidence.candidateCommit !== "CANDIDATE") {
    const runtime = digestAtCommit(evidence.candidateCommit, manifest.runtimeRoots);
    const configuration = digestAtCommit(evidence.candidateCommit, manifest.configurationRoots);
    if (runtime !== evidence.treeDigests.runtime || configuration !== evidence.treeDigests.configuration) {
      throw new Error("G31 candidate tree digest mismatch");
    }
  }
  return {
    candidateCommit: evidence.candidateCommit,
    digestChecked: evidence.candidateCommit !== "CANDIDATE",
    ...assertEvidenceHistory(evidence),
  };
}

export function assertFinalDeploymentIdentity(evidence) {
  if (evidence?.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  if (evidence?.candidateImpact?.deploymentRequired === false || evidence?.protocol?.deploymentRequired === false) {
    throw new Error("G31 final candidate cannot declare deploymentRequired:false");
  }
  if (evidence?.remoteDeployment?.deployedRuntimeCommit !== evidence?.sourceCommit) {
    throw new Error("G31 final witness deployedRuntimeCommit must equal sourceCommit");
  }
  if (evidence?.finalWitness?.primaryDeployment !== "deployed-final-c") {
    throw new Error("G31 final witness must redeploy the sealed final candidate");
  }
  if (evidence?.fixedNMeasurement?.latency?.sampleCount !== 10 || evidence?.fixedNMeasurement?.latency?.samples?.length !== 10) {
    throw new Error("G31 final evidence must contain fixed N=10 raw samples");
  }
  const oldSuid = evidence.fixedNMeasurement.latency.oldSuidGcProbe;
  if (oldSuid?.outcome !== "source-target-plus-active-safe-head success after target receipt GC" || oldSuid?.listStatus !== 200 || oldSuid?.waitState?.state?.targetReceipt !== false) {
    throw new Error("G31 final evidence must contain a successful receipt-GC old-SUID probe");
  }
  return { checked: true, sourceCommit: evidence.sourceCommit };
}

export function assertPostCandidatePaths(paths, evidenceCommit, run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  if (evidenceCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const supported = new Set([".github/workflows/ci.yml", "docs/SDT-G31-deploy-evidence.json"]);
  const unsupported = paths.filter((path) => !supported.has(path));
  if (unsupported.length > 0) throw new Error(`G31 post-candidate paths not allowlisted: ${unsupported.join(",")}`);
  if (paths.length !== 2 || !paths.includes(".github/workflows/ci.yml") || !paths.includes("docs/SDT-G31-deploy-evidence.json")) {
    throw new Error("G31 final R must contain exactly evidence and the retained-candidate append");
  }
  const diff = run(["diff", "--unified=0", `${evidenceCommit}..HEAD`, "--", ".github/workflows/ci.yml"]);
  const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length > 0 || additions.length !== 1 || additions[0].slice(1).trim() !== evidenceCommit) {
    throw new Error("G31 retained-candidate list must append exactly the candidate");
  }
  return { checked: true };
}

export function runSelfTest() {
  const manifest = loadManifest();
  const paths = [...new Set([
    ...manifest.runtimeRoots,
    ...manifest.configurationRoots,
    ...manifest.requiredRoots.map((entry) => entry.path),
    "packages/dcb-runtime/src/http/SerializedQueryWorker.ts",
    "test/g31-waitfor.spec.ts",
    "test/g31-sample.spec.ts",
    "test/g31-witness.spec.ts",
  ])];
  assertDeclaredRoots(manifest, paths);
  assertRequiredRoots(manifest, paths);
  let missingFailed = false;
  try { assertRequiredRoots(manifest, paths.filter((path) => path !== "test/g31-witness.spec.ts")); } catch (error) { missingFailed = String(error).includes("witness-fixture:test/g31-witness.spec.ts:missing-file"); }
  if (!missingFailed) throw new Error("G31 missing-root mutation did not fail");
  let declaredFailed = false;
  try { assertDeclaredRoots(manifest, paths.filter((path) => path !== "samples/meeting-room/public" && !path.startsWith("samples/meeting-room/public/"))); } catch (error) { declaredFailed = String(error).includes("declared-root:samples/meeting-room/public:missing"); }
  if (!declaredFailed) throw new Error("G31 declared-root mutation did not fail");
  let selfAuthorizedFailed = false;
  try { loadManifest(() => JSON.stringify({ ...manifest, postCandidateOperationalRecoveryPaths: ["scripts/deploy/g31-witness.mjs"] })); } catch (error) { selfAuthorizedFailed = String(error).includes("must not self-authorize"); }
  if (!selfAuthorizedFailed) throw new Error("G31 self-authorized post-C allowlist mutation did not fail");
  const commit = "c".repeat(40);
  const history = [{
    candidateCommit: PRIOR_G31_CANDIDATE,
    sourceCommit: PRIOR_G31_CANDIDATE,
    evidenceCommit: PRIOR_G31_EVIDENCE_COMMIT,
    evidencePath: "docs/SDT-G31-deploy-evidence.json",
    deployedRuntimeCommit: PRIOR_G31_CANDIDATE,
  }];
  assertEvidence({
    candidateCommit: "CANDIDATE",
    sourceCommit: "CANDIDATE",
    treeDigests: {
      algorithm: "sha256(path NUL content NUL, paths sorted)",
      runtime: "0".repeat(64),
      runtimeRoots: manifest.runtimeRoots,
      configuration: "1".repeat(64),
      configurationRoots: manifest.configurationRoots,
    },
    history,
  }, manifest);
  let missingHistoryFailed = false;
  try { assertEvidence({ candidateCommit: "CANDIDATE", sourceCommit: "CANDIDATE", treeDigests: { algorithm: "sha256(path NUL content NUL, paths sorted)", runtime: "0".repeat(64), runtimeRoots: manifest.runtimeRoots, configuration: "1".repeat(64), configurationRoots: manifest.configurationRoots } }, manifest); } catch (error) { missingHistoryFailed = String(error).includes("retain at least one prior C/R"); }
  if (!missingHistoryFailed) throw new Error("G31 historical C/R removal mutation did not fail");
  let historyFailed = false;
  try { assertEvidence({ candidateCommit: "CANDIDATE", sourceCommit: "CANDIDATE", treeDigests: { algorithm: "sha256(path NUL content NUL, paths sorted)", runtime: "0".repeat(64), runtimeRoots: manifest.runtimeRoots, configuration: "1".repeat(64), configurationRoots: manifest.configurationRoots }, history: [{ ...history[0], deployedRuntimeCommit: "d".repeat(40) }] }, manifest); } catch (error) { historyFailed = String(error).includes("historical deployed runtime"); }
  if (!historyFailed) throw new Error("G31 historical C/R identity mutation did not fail");
  const final = {
    candidateCommit: commit,
    sourceCommit: commit,
    candidateImpact: { deploymentRequired: true },
    protocol: { deploymentRequired: true },
    remoteDeployment: { deployedRuntimeCommit: commit },
    finalWitness: { primaryDeployment: "deployed-final-c" },
    fixedNMeasurement: { latency: { sampleCount: 10, samples: Array.from({ length: 10 }), oldSuidGcProbe: { outcome: "source-target-plus-active-safe-head success after target receipt GC", listStatus: 200, waitState: { state: { targetReceipt: false } } } } },
  };
  assertFinalDeploymentIdentity(final);
  let deploymentIdentityFailed = false;
  try { assertFinalDeploymentIdentity({ ...final, remoteDeployment: { deployedRuntimeCommit: "d".repeat(40) } }); } catch (error) { deploymentIdentityFailed = String(error).includes("deployedRuntimeCommit"); }
  if (!deploymentIdentityFailed) throw new Error("G31 deployed/source mutation did not fail");
  let deploymentRequiredFailed = false;
  try { assertFinalDeploymentIdentity({ ...final, candidateImpact: { deploymentRequired: false } }); } catch (error) { deploymentRequiredFailed = String(error).includes("deploymentRequired:false"); }
  if (!deploymentRequiredFailed) throw new Error("G31 deploymentRequired mutation did not fail");
  let oldSuidFailed = false;
  try { assertFinalDeploymentIdentity({ ...final, fixedNMeasurement: { latency: { ...final.fixedNMeasurement.latency, oldSuidGcProbe: { listStatus: 200 } } } }); } catch (error) { oldSuidFailed = String(error).includes("old-SUID"); }
  if (!oldSuidFailed) throw new Error("G31 old-SUID witness mutation did not fail");
  const diff = () => `+${commit}\n`;
  assertPostCandidatePaths(["docs/SDT-G31-deploy-evidence.json", ".github/workflows/ci.yml"], commit, diff);
  let operationalEditFailed = false;
  try { assertPostCandidatePaths(["docs/SDT-G31-deploy-evidence.json", ".github/workflows/ci.yml", "scripts/deploy/g31-measure.mjs"], commit, diff); } catch (error) { operationalEditFailed = String(error).includes("post-candidate paths not allowlisted"); }
  if (!operationalEditFailed) throw new Error("G31 post-C operational edit mutation did not fail");
  let retainedFailed = false;
  try { assertPostCandidatePaths(["docs/SDT-G31-deploy-evidence.json", ".github/workflows/ci.yml"], commit, () => `+${"d".repeat(40)}\n`); } catch (error) { retainedFailed = String(error).includes("retained-candidate"); }
  if (!retainedFailed) throw new Error("G31 retained SHA mutation did not fail");
  return {
    requiredRoots: manifest.requiredRoots.length,
    declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length,
    mutations: ["missing-file", "declared-root-removal", "self-authorized-allowlist", "historical-c-r-removal", "historical-c-r-identity", "deployment-identity", "deployment-required", "old-suid-gc", "strict-R-operational-edit", "retained-sha"],
  };
}

function main() {
  if (process.env.SDT_G31_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G31 candidate gate forced failure");
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
    return;
  }
  const manifest = loadManifest();
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const proof = assertEvidence(evidence, manifest);
  const deployment = assertFinalDeploymentIdentity(evidence);
  const declared = assertDeclaredRoots(manifest);
  const required = assertRequiredRoots(manifest);
  const candidate = evidence.candidateCommit;
  const active = candidate !== "CANDIDATE" && SHA.test(candidate) && (() => {
    try { execFileSync("git", ["merge-base", "--is-ancestor", candidate, "HEAD"], { cwd: root }); return true; } catch { return false; }
  })();
  const paths = active ? execFileSync("git", ["diff", "--name-only", `${candidate}..HEAD`], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean) : [];
  const post = active ? assertPostCandidatePaths(paths, candidate) : { checked: false, reason: candidate === "CANDIDATE" ? "placeholder-candidate" : "candidate-not-ancestor" };
  console.log(JSON.stringify({ ...proof, deployment, manifest: { ...declared, ...required }, postCandidate: post }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

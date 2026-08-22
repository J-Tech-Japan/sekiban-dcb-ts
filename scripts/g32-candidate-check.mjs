#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digestAtCommit as deploymentConfigDigest } from "./deploy/g32-config-digest.mjs";

const root = process.cwd();
const manifestPath = resolve(root, "docs/SDT-G32-required-roots.json");
const evidencePath = resolve(root, "docs/SDT-G32-cutover-evidence.json");
const cutoverPath = resolve(root, "contracts/g32-cutover.json");
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runGit(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding });
}

function pathsAtTree() {
  return [...new Set([
    ...runGit(["ls-files"]).split(/\r?\n/),
    ...runGit(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/),
  ].map((path) => path.trim()).filter(Boolean))];
}

function rootCovers(rootPath, path) {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

export function loadManifest(read = (path) => readFileSync(path, "utf8")) {
  const manifest = JSON.parse(read(manifestPath));
  if (
    manifest?.schemaVersion !== 1 || !Array.isArray(manifest.runtimeRoots) ||
    !Array.isArray(manifest.configurationRoots) || !Array.isArray(manifest.requiredRoots)
  ) throw new Error("G32 required-root manifest schema invalid");
  const allRoots = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  if (allRoots.some((path) => typeof path !== "string" || path.length === 0) || new Set(allRoots).size !== allRoots.length) {
    throw new Error("G32 declared root set is invalid");
  }
  if (manifest.requiredRoots.some((entry) => typeof entry?.rootId !== "string" || typeof entry?.path !== "string" || (entry.kind !== "file" && entry.kind !== "directory"))) {
    throw new Error("G32 required-root entry invalid");
  }
  if (Object.hasOwn(manifest, "postCandidateOperationalRecoveryPaths")) {
    throw new Error("G32 final C/R manifest must not self-authorize post-candidate operational recovery paths");
  }
  return manifest;
}

export function assertDeclaredRoots(manifest, paths = pathsAtTree()) {
  for (const rootPath of [...manifest.runtimeRoots, ...manifest.configurationRoots]) {
    if (!paths.some((path) => rootCovers(rootPath, path))) throw new Error(`declared-root:${rootPath}:missing`);
  }
  return { declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length };
}

export function assertRequiredRoots(manifest, paths = pathsAtTree()) {
  for (const entry of manifest.requiredRoots) {
    if (entry.kind === "file" && !paths.includes(entry.path)) throw new Error(`${entry.rootId}:${entry.path}:missing-file`);
    if (entry.kind === "directory" && !paths.some((path) => path.startsWith(`${entry.path}/`))) throw new Error(`${entry.rootId}:${entry.path}:empty-directory`);
  }
  return { requiredRoots: manifest.requiredRoots.length };
}

export function digestAtCommit(commit, roots, run = (args) => runGit(args, null)) {
  const entries = run(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots]).toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G32 digest root resolved to no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(run(["show", `${commit}:${path}`])); hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertCandidateMaterialCoverage(candidate, manifest, run = (args) => runGit(args)) {
  if (!SHA.test(candidate)) throw new Error("G32 candidate coverage requires a full candidate SHA");
  const parent = String(run(["rev-parse", `${candidate}^`])).trim();
  const changed = String(run(["diff", "--name-only", `${parent}..${candidate}`])).split(/\r?\n/).filter(Boolean);
  if (changed.length === 0) throw new Error("G32 final candidate contains no material");
  const roots = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  const uncovered = changed.filter((path) => !roots.some((rootPath) => rootCovers(rootPath, path)));
  if (uncovered.length > 0) throw new Error(`G32 final candidate material is outside manifest roots: ${uncovered.join(",")}`);
  return { candidate, parent, materialPaths: changed.length };
}

export function assertBridgeEvidence(evidence, cutover) {
  const expectedComponents = [...cutover.final.requiredComponents].sort();
  const expectedEntrypoints = [...cutover.final.requiredWriterEntrypoints].sort();
  if (
    evidence?.task !== "SDT-G32" || evidence?.phase !== "bridge-freeze" ||
    evidence?.candidateCommit !== cutover.bridge.candidateCommit || evidence?.sourceCommit !== cutover.bridge.candidateCommit ||
    evidence?.protocol?.oldFormatOnly !== true || evidence?.protocol?.freezeOnly !== true
  ) throw new Error("G32 bridge evidence identity is invalid");
  if (JSON.stringify([...(evidence?.freezeAcknowledgements?.componentSet ?? [])].sort()) !== JSON.stringify(expectedComponents)) {
    throw new Error("G32 bridge component acknowledgement set is invalid");
  }
  if (JSON.stringify([...(evidence?.freezeAcknowledgements?.writerEntrypointSet ?? [])].sort()) !== JSON.stringify(expectedEntrypoints)) {
    throw new Error("G32 bridge writer coverage acknowledgement is invalid");
  }
  if (evidence?.freezePreconditions?.inFlight !== 0 || evidence?.freezePreconditions?.pendingOutbox?.disposition !== "explicitly-discarded") {
    throw new Error("G32 bridge freeze preconditions are invalid");
  }
  return { bridgeCandidate: evidence.candidateCommit, components: expectedComponents.length, writerEntrypoints: expectedEntrypoints.length };
}

export function assertEvidence(evidence, manifest, cutover) {
  const candidate = evidence?.candidateCommit;
  if (typeof candidate !== "string" || (candidate !== "CANDIDATE" && !SHA.test(candidate))) {
    throw new Error("G32 evidence candidateCommit is invalid");
  }
  if (evidence?.sourceCommit !== candidate) throw new Error("G32 evidence sourceCommit must equal candidateCommit");
  if (
    evidence?.protocol?.selfReference !== false || evidence?.protocol?.deploymentRequired !== true ||
    evidence?.candidateImpact?.deploymentRequired !== true
  ) throw new Error("G32 evidence candidate protocol is invalid");
  if (evidence?.treeDigests?.algorithm !== "sha256(path NUL content NUL, paths sorted)") throw new Error("G32 evidence digest algorithm is invalid");
  if (
    JSON.stringify(evidence.treeDigests?.runtimeRoots) !== JSON.stringify(manifest.runtimeRoots) ||
    JSON.stringify(evidence.treeDigests?.configurationRoots) !== JSON.stringify(manifest.configurationRoots) ||
    !SHA256.test(evidence.treeDigests?.runtime) || !SHA256.test(evidence.treeDigests?.configuration)
  ) throw new Error("G32 evidence roots or digests are invalid");
  if (evidence?.bridge?.candidateCommit !== cutover.bridge.candidateCommit || evidence?.bridge?.evidencePath !== cutover.bridge.evidencePath) {
    throw new Error("G32 final evidence does not reference sealed bridge B");
  }
  if (candidate !== "CANDIDATE") {
    const runtime = digestAtCommit(candidate, manifest.runtimeRoots);
    const configuration = digestAtCommit(candidate, manifest.configurationRoots);
    if (runtime !== evidence.treeDigests.runtime || configuration !== evidence.treeDigests.configuration) {
      throw new Error("G32 candidate tree digest mismatch");
    }
    if (evidence?.deploymentConfig?.digest !== deploymentConfigDigest(candidate)) {
      throw new Error("G32 candidate deployment config digest mismatch");
    }
  }
  return { candidateCommit: candidate, digestChecked: candidate !== "CANDIDATE" };
}

export function assertFinalDeploymentIdentity(evidence, cutover) {
  if (evidence?.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const candidate = evidence.candidateCommit;
  const final = cutover.final;
  const remote = evidence?.remoteDeployment;
  if (
    remote?.sourceCommit !== candidate || remote?.deployedRuntimeCommit !== candidate ||
    remote?.serviceId !== final.serviceId || remote?.pipelineDatabaseId !== final.pipelineDatabase.id ||
    remote?.materializedViewDatabaseId !== final.materializedViewDatabase.id || remote?.queue !== final.queue
  ) throw new Error("G32 deployedRuntimeCommit/source/new-binding identity mismatch");
  if (evidence?.finalWitness?.postFinalCDeployment !== true || evidence?.finalWitness?.otherServicesUnchanged !== true) {
    throw new Error("G32 final-C witness identity is incomplete");
  }
  if (evidence?.dataPreservation?.status !== "not-applicable-full-wipe") throw new Error("G32 wipe data-preservation witness is not explicit");
  if (evidence?.postWitness?.rawV1?.status !== 404 || evidence?.postWitness?.staleBridgeRoute?.status !== 404) {
    throw new Error("G32 old V1 or bridge closure was not witnessed");
  }
  const latency = evidence?.fixedNMeasurement?.latency;
  if (latency?.sampleCount !== final.fixedSamples || !Array.isArray(latency?.samples) || latency.samples.length !== final.fixedSamples) {
    throw new Error("G32 final evidence must contain fixed N=10 raw samples");
  }
  if (!Array.isArray(latency?.fiveEndpointConformance) || latency.fiveEndpointConformance.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)) {
    throw new Error("G32 five-endpoint conformance evidence is incomplete");
  }
  if (latency?.rawV1?.status !== 404) throw new Error("G32 raw V1 closure evidence is incomplete");
  const stale = latency?.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch") {
    throw new Error("G32 old-SUID typed stale-negative is incomplete");
  }
  const expectedEvents = final.fixedSamples * 2;
  if (
    Number(latency?.finalStoreState?.eventCount) !== expectedEvents ||
    Number(latency?.finalStoreState?.eventOpsCount) !== expectedEvents ||
    latency?.finalStoreState?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 new-store post-measurement counts are invalid");
  if (evidence?.queueTopology?.primaryExclusive !== true || evidence?.queueTopology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 final Queue topology was not witnessed");
  }
  return { checked: true, sourceCommit: candidate, expectedEvents };
}

export function assertPostCandidatePaths(paths, candidate, run = (args) => runGit(args)) {
  if (candidate === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const allowed = new Set([".github/workflows/ci.yml", "docs/SDT-G32-cutover-evidence.json"]);
  const unsupported = paths.filter((path) => !allowed.has(path));
  if (unsupported.length > 0) throw new Error(`G32 post-candidate paths not allowlisted: ${unsupported.join(",")}`);
  if (paths.length !== 2 || !paths.includes(".github/workflows/ci.yml") || !paths.includes("docs/SDT-G32-cutover-evidence.json")) {
    throw new Error("G32 R must contain exactly final evidence and one retained-C append");
  }
  const diff = String(run(["diff", "--unified=0", `${candidate}..HEAD`, "--", ".github/workflows/ci.yml"]));
  const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== candidate) {
    throw new Error("G32 retained-candidate list must append exactly final C once");
  }
  return { checked: true };
}

export function runSelfTest() {
  const manifest = loadManifest();
  const declared = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  const required = manifest.requiredRoots.map((entry) => entry.path);
  const paths = [...new Set([...declared, ...required])];
  assertDeclaredRoots(manifest, paths);
  assertRequiredRoots(manifest, paths);
  let missingRootRed = false;
  const missing = manifest.requiredRoots[0];
  try { assertRequiredRoots(manifest, paths.filter((path) => path !== missing.path)); } catch (error) { missingRootRed = String(error).includes(`${missing.rootId}:${missing.path}:missing-file`); }
  if (!missingRootRed) throw new Error("G32 required-root removal mutation unexpectedly passed");
  let selfAuthorizationRed = false;
  try { loadManifest(() => JSON.stringify({ ...manifest, postCandidateOperationalRecoveryPaths: ["scripts/deploy/g32-deploy-cutover.sh"] })); } catch (error) { selfAuthorizationRed = String(error).includes("must not self-authorize"); }
  if (!selfAuthorizationRed) throw new Error("G32 self-authorized post-C mutation unexpectedly passed");
  const candidate = "c".repeat(40);
  const coverageRun = (args) => {
    if (args[0] === "rev-parse") return `${"p".repeat(40)}\n`;
    return "packages/dcb-runtime/src/eventRecord.ts\ndocs/SDT-G32-oracle-map.md\n";
  };
  assertCandidateMaterialCoverage(candidate, manifest, coverageRun);
  let coverageRed = false;
  try { assertCandidateMaterialCoverage(candidate, manifest, (args) => args[0] === "rev-parse" ? `${"p".repeat(40)}\n` : "outside-g32-material.txt\n"); } catch (error) { coverageRed = String(error).includes("outside manifest roots"); }
  if (!coverageRed) throw new Error("G32 undeclared candidate material mutation unexpectedly passed");
  const cutover = readJson(cutoverPath);
  const bridge = readJson(resolve(root, cutover.bridge.evidencePath));
  assertBridgeEvidence(bridge, cutover);
  let bridgeRed = false;
  try { assertBridgeEvidence({ ...bridge, freezeAcknowledgements: { ...bridge.freezeAcknowledgements, writerEntrypointSet: [] } }, cutover); } catch (error) { bridgeRed = String(error).includes("writer coverage"); }
  if (!bridgeRed) throw new Error("G32 bridge coverage mutation unexpectedly passed");
  const placeholder = {
    candidateCommit: "CANDIDATE",
    sourceCommit: "CANDIDATE",
    protocol: { selfReference: false, deploymentRequired: true },
    candidateImpact: { deploymentRequired: true },
    bridge: { candidateCommit: cutover.bridge.candidateCommit, evidencePath: cutover.bridge.evidencePath },
    treeDigests: {
      algorithm: "sha256(path NUL content NUL, paths sorted)", runtime: "0".repeat(64), runtimeRoots: manifest.runtimeRoots,
      configuration: "1".repeat(64), configurationRoots: manifest.configurationRoots,
    },
  };
  assertEvidence(placeholder, manifest, cutover);
  const final = {
    candidateCommit: candidate,
    sourceCommit: candidate,
    remoteDeployment: {
      sourceCommit: candidate, deployedRuntimeCommit: candidate, serviceId: cutover.final.serviceId,
      pipelineDatabaseId: cutover.final.pipelineDatabase.id, materializedViewDatabaseId: cutover.final.materializedViewDatabase.id, queue: cutover.final.queue,
    },
    finalWitness: { postFinalCDeployment: true, otherServicesUnchanged: true },
    dataPreservation: { status: "not-applicable-full-wipe" },
    postWitness: { rawV1: { status: 404 }, staleBridgeRoute: { status: 404 } },
    fixedNMeasurement: { latency: {
      sampleCount: cutover.final.fixedSamples, samples: Array.from({ length: cutover.final.fixedSamples }),
      fiveEndpointConformance: Array.from({ length: 5 }, () => ({ status: 200 })), rawV1: { status: 404 },
      staleNegatives: [{ id: "old-37-character-suid-list", status: 400, outcome: "typed-rejected-before-list-dispatch" }],
      finalStoreState: { eventCount: cutover.final.fixedSamples * 2, eventOpsCount: cutover.final.fixedSamples * 2, legacySerializedEventTablePresent: false },
    } },
    queueTopology: { primaryExclusive: true, receiverServiceBindingOnly: true },
  };
  assertFinalDeploymentIdentity(final, cutover);
  let staleRed = false;
  try { assertFinalDeploymentIdentity({ ...final, fixedNMeasurement: { latency: { ...final.fixedNMeasurement.latency, staleNegatives: [{ id: "old-37-character-suid-list", status: 200 }] } } }, cutover); } catch (error) { staleRed = String(error).includes("old-SUID"); }
  if (!staleRed) throw new Error("G32 stale SUID mutation unexpectedly passed");
  assertPostCandidatePaths([".github/workflows/ci.yml", "docs/SDT-G32-cutover-evidence.json"], candidate, () => `+${candidate}\n`);
  let postPathRed = false;
  try { assertPostCandidatePaths([".github/workflows/ci.yml", "docs/SDT-G32-cutover-evidence.json", "scripts/deploy/g32-measure.mjs"], candidate, () => `+${candidate}\n`); } catch (error) { postPathRed = String(error).includes("not allowlisted"); }
  if (!postPathRed) throw new Error("G32 post-C operational edit mutation unexpectedly passed");
  let retainedRed = false;
  try { assertPostCandidatePaths([".github/workflows/ci.yml", "docs/SDT-G32-cutover-evidence.json"], candidate, () => `+${"d".repeat(40)}\n`); } catch (error) { retainedRed = String(error).includes("retained-candidate"); }
  if (!retainedRed) throw new Error("G32 retained candidate mutation unexpectedly passed");
  return {
    declaredRoots: declared.length,
    requiredRoots: required.length,
    mutations: ["missing-root", "self-authorized-post-c", "undeclared-material", "bridge-entrypoint", "old-suid", "post-c-operational-edit", "retained-sha"],
  };
}

function main() {
  if (process.env.SDT_G32_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G32 candidate gate forced failure");
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
    return;
  }
  const manifest = loadManifest();
  const cutover = readJson(cutoverPath);
  const bridge = assertBridgeEvidence(readJson(resolve(root, cutover.bridge.evidencePath)), cutover);
  const evidence = readJson(evidencePath);
  const proof = assertEvidence(evidence, manifest, cutover);
  const deployment = assertFinalDeploymentIdentity(evidence, cutover);
  const declared = assertDeclaredRoots(manifest);
  const required = assertRequiredRoots(manifest);
  const candidate = evidence.candidateCommit;
  const active = candidate !== "CANDIDATE" && SHA.test(candidate) && (() => {
    try { runGit(["merge-base", "--is-ancestor", candidate, "HEAD"]); return true; } catch { return false; }
  })();
  const material = active ? assertCandidateMaterialCoverage(candidate, manifest) : { checked: false, reason: candidate === "CANDIDATE" ? "placeholder-candidate" : "candidate-not-ancestor" };
  const postPaths = active ? runGit(["diff", "--name-only", `${candidate}..HEAD`]).split(/\r?\n/).filter(Boolean) : [];
  const post = active ? assertPostCandidatePaths(postPaths, candidate) : { checked: false, reason: candidate === "CANDIDATE" ? "placeholder-candidate" : "candidate-not-ancestor" };
  console.log(JSON.stringify({ bridge, evidence: proof, deployment, manifest: { ...declared, ...required }, material, postCandidate: post }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digestAtCommit as deploymentConfigDigest, G32_DEPLOYMENT_CONFIG_PATHS } from "./deploy/g32-config-digest.mjs";

const root = process.cwd();
const manifestPath = resolve(root, "docs/SDT-G32-required-roots.json");
const evidencePath = resolve(root, "docs/SDT-G32-cutover-evidence.json");
const cutoverPath = resolve(root, "contracts/g32-cutover.json");
const INITIAL_CANDIDATE = "9bf654eb555e56a2b0d5ed9f04d0aad670866e9e";
const INITIAL_EVIDENCE_COMMIT = "fc89572e2e0a8b84447591f87be5d05d57396435";
const REJECTED_FORWARD_PREFLIGHT_CANDIDATE = "a8f98355bb6de0454725d34f0238cd12efd4519c";
const C2_CANDIDATE = "0b38755443cce9d4a1a4383e18ba42499c390f63";
const C2_EVIDENCE_COMMIT = "acc1dc1746a7310410ced0ae556ec7f87e4970a2";
const C3_CANDIDATE = "c5441dc23e144466d26e13d7ffab4db7eca2e6ae";
const C3_EVIDENCE_COMMIT = "6143f0402cfbffd78b8fc041c7127578c3fcf638";
const C4_CANDIDATE = "aff97424b136be9f88e6804ced1562d9b81709cd";
const C4_EVIDENCE_COMMIT = "be1f251f13b60544744a2427bae82a1ab85f38f7";
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST_ALGORITHM = "sha256(path NUL content NUL, paths sorted)";
const R_PATHS = Object.freeze([".github/workflows/ci.yml", "docs/SDT-G32-cutover-evidence.json"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding });
}

function gitText(args) {
  return String(git(args));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rootCovers(rootPath, path) {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function assertSha(value, label) {
  if (!SHA.test(value)) throw new Error(`${label} must be a full commit SHA`);
}

function assertSha256(value, label) {
  if (!SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function currentPaths() {
  return [...new Set([
    ...gitText(["ls-files"]).split(/\r?\n/),
    ...gitText(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/),
  ].map((path) => path.trim()).filter(Boolean))];
}

function forwardOf(evidence) {
  if (evidence?.forwardRedeploy === null || typeof evidence?.forwardRedeploy !== "object" || Array.isArray(evidence.forwardRedeploy)) {
    throw new Error("G32 C2 forward-redeploy evidence is missing");
  }
  return evidence.forwardRedeploy;
}

function c3Of(evidence) {
  if (evidence?.forwardRedeployC3 === null || typeof evidence?.forwardRedeployC3 !== "object" || Array.isArray(evidence.forwardRedeployC3)) {
    throw new Error("G32 C3 forward-redeploy evidence is missing");
  }
  return evidence.forwardRedeployC3;
}

function c4Of(evidence) {
  if (evidence?.forwardRedeployC4 === null || typeof evidence?.forwardRedeployC4 !== "object" || Array.isArray(evidence.forwardRedeployC4)) {
    throw new Error("G32 C4 forward-redeploy evidence is missing");
  }
  return evidence.forwardRedeployC4;
}

function c5Of(evidence) {
  if (evidence?.forwardRedeployC5 === null || typeof evidence?.forwardRedeployC5 !== "object" || Array.isArray(evidence.forwardRedeployC5)) {
    throw new Error("G32 C5 forward-redeploy evidence is missing");
  }
  return evidence.forwardRedeployC5;
}

export function loadManifest(read = (path) => readFileSync(path, "utf8")) {
  const manifest = JSON.parse(read(manifestPath));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.runtimeRoots) || !Array.isArray(manifest.configurationRoots) || !Array.isArray(manifest.requiredRoots)) {
    throw new Error("G32 required-root manifest schema invalid");
  }
  const roots = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  if (roots.some((path) => typeof path !== "string" || path.length === 0) || new Set(roots).size !== roots.length) {
    throw new Error("G32 declared root set is invalid");
  }
  if (manifest.requiredRoots.some((entry) => typeof entry?.rootId !== "string" || typeof entry?.path !== "string" || !["file", "directory"].includes(entry.kind))) {
    throw new Error("G32 required-root entry invalid");
  }
  if (Object.hasOwn(manifest, "postCandidateOperationalRecoveryPaths")) {
    throw new Error("G32 final C/R manifest must not self-authorize post-candidate operational recovery paths");
  }
  return manifest;
}

export function assertDeclaredRoots(manifest, paths = currentPaths()) {
  for (const rootPath of [...manifest.runtimeRoots, ...manifest.configurationRoots]) {
    if (!paths.some((path) => rootCovers(rootPath, path))) throw new Error(`declared-root:${rootPath}:missing`);
  }
  return { declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length };
}

export function assertRequiredRoots(manifest, paths = currentPaths()) {
  for (const entry of manifest.requiredRoots) {
    if (entry.kind === "file" && !paths.includes(entry.path)) throw new Error(`${entry.rootId}:${entry.path}:missing-file`);
    if (entry.kind === "directory" && !paths.some((path) => path.startsWith(`${entry.path}/`))) throw new Error(`${entry.rootId}:${entry.path}:empty-directory`);
  }
  return { requiredRoots: manifest.requiredRoots.length };
}

export function digestAtCommit(commit, roots, run = (args) => git(args, null)) {
  const entries = run(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots]).toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G32 digest root resolved to no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(run(["show", `${commit}:${path}`])); hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertCandidateMaterialCoverage(candidate, manifest, run = (args) => git(args)) {
  assertSha(candidate, "G32 candidate coverage candidate");
  const parent = String(run(["rev-parse", `${candidate}^`])).trim();
  const changed = String(run(["diff", "--name-only", `${parent}..${candidate}`])).split(/\r?\n/).filter(Boolean);
  if (changed.length === 0) throw new Error("G32 final candidate contains no material");
  const roots = [...manifest.runtimeRoots, ...manifest.configurationRoots];
  const uncovered = changed.filter((path) => !roots.some((rootPath) => rootCovers(rootPath, path)));
  if (uncovered.length > 0) throw new Error(`G32 final candidate material is outside manifest roots: ${uncovered.join(",")}`);
  return { candidate, parent, materialPaths: changed.length };
}

export function assertBridgeEvidence(evidence, cutover) {
  const components = [...cutover.final.requiredComponents].sort();
  const entrypoints = [...cutover.final.requiredWriterEntrypoints].sort();
  if (
    evidence?.task !== "SDT-G32" || evidence?.phase !== "bridge-freeze" ||
    evidence?.candidateCommit !== cutover.bridge.candidateCommit || evidence?.sourceCommit !== cutover.bridge.candidateCommit ||
    evidence?.protocol?.oldFormatOnly !== true || evidence?.protocol?.freezeOnly !== true
  ) throw new Error("G32 bridge evidence identity is invalid");
  if (!same([...(evidence?.freezeAcknowledgements?.componentSet ?? [])].sort(), components)) throw new Error("G32 bridge component acknowledgement set is invalid");
  if (!same([...(evidence?.freezeAcknowledgements?.writerEntrypointSet ?? [])].sort(), entrypoints)) throw new Error("G32 bridge writer coverage acknowledgement is invalid");
  if (evidence?.freezePreconditions?.inFlight !== 0 || evidence?.freezePreconditions?.pendingOutbox?.disposition !== "explicitly-discarded") {
    throw new Error("G32 bridge freeze preconditions are invalid");
  }
  return { bridgeCandidate: evidence.candidateCommit, components: components.length, writerEntrypoints: entrypoints.length };
}

function assertDigestShape(treeDigests, roots, label, placeholder = false) {
  if (treeDigests?.algorithm !== DIGEST_ALGORITHM) throw new Error(`${label} digest algorithm is invalid`);
  if (!same(treeDigests?.runtimeRoots, roots.runtimeRoots) || !same(treeDigests?.configurationRoots, roots.configurationRoots)) {
    throw new Error(`${label} digest roots do not equal declared roots`);
  }
  for (const field of ["runtime", "configuration"]) {
    const value = treeDigests?.[field];
    if (placeholder && (value === "0".repeat(64) || value === "1".repeat(64))) continue;
    assertSha256(value, `${label} ${field}`);
  }
}

function assertInitialEvidenceCommit() {
  const paths = gitText(["diff", "--name-only", `${INITIAL_CANDIDATE}..${INITIAL_EVIDENCE_COMMIT}`]).split(/\r?\n/).filter(Boolean).sort();
  if (!same(paths, [...R_PATHS].sort())) throw new Error("G32 C1/R1 history is not exactly evidence + retained-C");
  const ciDiff = gitText(["diff", "--unified=0", `${INITIAL_CANDIDATE}..${INITIAL_EVIDENCE_COMMIT}`, "--", ".github/workflows/ci.yml"]);
  const additions = ciDiff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = ciDiff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== INITIAL_CANDIDATE) {
    throw new Error("G32 C1 retained candidate history is invalid");
  }
  return { candidate: INITIAL_CANDIDATE, evidenceCommit: INITIAL_EVIDENCE_COMMIT };
}

function assertC2EvidenceCommit() {
  const paths = gitText(["diff", "--name-only", `${C2_CANDIDATE}..${C2_EVIDENCE_COMMIT}`]).split(/\r?\n/).filter(Boolean).sort();
  if (!same(paths, [...R_PATHS].sort())) throw new Error("G32 C2/R2 history is not exactly evidence + retained-C");
  const ciDiff = gitText(["diff", "--unified=0", `${C2_CANDIDATE}..${C2_EVIDENCE_COMMIT}`, "--", ".github/workflows/ci.yml"]);
  const additions = ciDiff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = ciDiff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== C2_CANDIDATE) {
    throw new Error("G32 C2 retained candidate history is invalid");
  }
  return { candidate: C2_CANDIDATE, evidenceCommit: C2_EVIDENCE_COMMIT };
}

function assertC3EvidenceCommit() {
  const paths = gitText(["diff", "--name-only", `${C3_CANDIDATE}..${C3_EVIDENCE_COMMIT}`]).split(/\r?\n/).filter(Boolean).sort();
  if (!same(paths, [...R_PATHS].sort())) throw new Error("G32 C3/R3 history is not exactly evidence + retained-C");
  const ciDiff = gitText(["diff", "--unified=0", `${C3_CANDIDATE}..${C3_EVIDENCE_COMMIT}`, "--", ".github/workflows/ci.yml"]);
  const additions = ciDiff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = ciDiff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== C3_CANDIDATE) {
    throw new Error("G32 C3 retained candidate history is invalid");
  }
  return { candidate: C3_CANDIDATE, evidenceCommit: C3_EVIDENCE_COMMIT };
}

/** The original wipe exception is C1-only historical evidence. */
export function assertInitialCutoverHistory(evidence, cutover) {
  const bridge = assertBridgeEvidence(readJson(resolve(root, cutover.bridge.evidencePath)), cutover);
  if (
    evidence?.task !== "SDT-G32" || evidence?.candidateCommit !== INITIAL_CANDIDATE || evidence?.sourceCommit !== INITIAL_CANDIDATE ||
    evidence?.protocol?.selfReference !== false || evidence?.protocol?.deploymentRequired !== true ||
    evidence?.candidateImpact?.deploymentRequired !== true ||
    evidence?.bridge?.candidateCommit !== cutover.bridge.candidateCommit || evidence?.bridge?.evidencePath !== cutover.bridge.evidencePath
  ) throw new Error("G32 C1 cutover history identity is invalid");
  assertDigestShape(evidence.treeDigests, evidence.treeDigests, "G32 C1");
  if (
    digestAtCommit(INITIAL_CANDIDATE, evidence.treeDigests.runtimeRoots) !== evidence.treeDigests.runtime ||
    digestAtCommit(INITIAL_CANDIDATE, evidence.treeDigests.configurationRoots) !== evidence.treeDigests.configuration ||
    evidence?.deploymentConfig?.digest !== deploymentConfigDigest(INITIAL_CANDIDATE)
  ) throw new Error("G32 C1 historical digest mismatch");
  const final = cutover.final;
  const remote = evidence?.remoteDeployment;
  if (
    remote?.sourceCommit !== INITIAL_CANDIDATE || remote?.deployedRuntimeCommit !== INITIAL_CANDIDATE ||
    remote?.serviceId !== final.serviceId || remote?.pipelineDatabaseId !== final.pipelineDatabase.id ||
    remote?.materializedViewDatabaseId !== final.materializedViewDatabase.id || remote?.queue !== final.queue
  ) throw new Error("G32 C1 deployed identity is invalid");
  const latency = evidence?.fixedNMeasurement?.latency;
  const stale = latency?.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (
    evidence?.dataPreservation?.status !== "not-applicable-full-wipe" ||
    evidence?.finalWitness?.postFinalCDeployment !== true || evidence?.finalWitness?.otherServicesUnchanged !== true ||
    evidence?.postWitness?.rawV1?.status !== 404 || evidence?.postWitness?.staleBridgeRoute?.status !== 404 ||
    evidence?.queueTopology?.primaryExclusive !== true || evidence?.queueTopology?.receiverServiceBindingOnly !== true ||
    latency?.sampleCount !== final.fixedSamples || latency?.samples?.length !== final.fixedSamples || latency?.rawV1?.status !== 404 ||
    stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch" ||
    Number(latency?.finalStoreState?.eventCount) !== final.fixedSamples * 2 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== final.fixedSamples * 2
  ) throw new Error("G32 C1 historical cutover witness is incomplete");
  return { ...assertInitialEvidenceCommit(), c2: assertC2EvidenceCommit(), bridge, sourceCommit: INITIAL_CANDIDATE };
}

function assertForwardProtocol(forward) {
  if (
    forward?.protocol?.selfReference !== false || forward?.protocol?.deploymentRequired !== true ||
    forward?.protocol?.forwardOnly !== true || forward?.protocol?.cutoverReexecuted !== false ||
    forward?.candidateImpact?.deploymentRequired !== true || forward?.candidateImpact?.newServiceId !== false ||
    forward?.candidateImpact?.newD1Database !== false || forward?.candidateImpact?.wipe !== false
  ) throw new Error("G32 C2 protocol must be deployment-required forward-only without another cutover/wipe");
  if (
    forward?.history?.initialCandidate !== INITIAL_CANDIDATE ||
    forward?.history?.initialEvidenceCommit !== INITIAL_EVIDENCE_COMMIT ||
    forward?.history?.initialCutover !== "completed-once" ||
    forward?.history?.rejectedPreparedCandidate !== REJECTED_FORWARD_PREFLIGHT_CANDIDATE ||
    forward?.history?.rejectedPreparedCandidateRemoteEffects !== "none-before-wrangler"
  ) throw new Error("G32 C2 must retain C1/R1 history");
}

/**
 * C2 is historical evidence. Its root list is checked from the C2 object,
 * rather than against C3's intentionally expanded manifest.
 */
export function assertForwardEvidenceShape(forward) {
  const candidate = forward?.candidateCommit;
  if (candidate !== "CANDIDATE" && !SHA.test(candidate)) throw new Error("G32 C2 candidateCommit is invalid");
  if (candidate !== "CANDIDATE" && candidate !== C2_CANDIDATE) throw new Error("G32 historical C2 candidate changed");
  if (forward?.sourceCommit !== candidate) throw new Error("G32 C2 sourceCommit must equal candidateCommit");
  assertForwardProtocol(forward);
  const roots = {
    runtimeRoots: forward?.treeDigests?.runtimeRoots,
    configurationRoots: forward?.treeDigests?.configurationRoots,
  };
  assertDigestShape(forward?.treeDigests, roots, "G32 C2", candidate === "CANDIDATE");
  if (candidate !== "CANDIDATE") {
    if (
      digestAtCommit(candidate, roots.runtimeRoots) !== forward.treeDigests.runtime ||
      digestAtCommit(candidate, roots.configurationRoots) !== forward.treeDigests.configuration ||
      deploymentConfigDigest(candidate) !== forward?.deploymentConfig?.digest
    ) throw new Error("G32 C2 candidate digest mismatch");
  }
  return { candidateCommit: candidate, digestChecked: candidate !== "CANDIDATE" };
}

function assertSameBindings(remote, initial) {
  for (const field of ["worker", "receiver", "serviceId", "pipelineDatabaseId", "materializedViewDatabaseId", "queue", "deadLetterQueue"]) {
    if (remote?.[field] !== initial?.[field]) throw new Error(`G32 C2 must retain C1 ${field}`);
  }
  if (!same(remote?.durableObjectNamespaces, initial?.durableObjectNamespaces)) throw new Error("G32 C2 must retain C1 Durable Object namespaces");
}

export function assertForwardDeploymentIdentity(evidence, cutover) {
  const forward = forwardOf(evidence);
  if (forward.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const candidate = forward.candidateCommit;
  const remote = forward?.remoteDeployment;
  if (remote?.sourceCommit !== candidate || remote?.deployedRuntimeCommit !== candidate) throw new Error("G32 C2 deployedRuntimeCommit/sourceCommit mismatch");
  assertSameBindings(remote, evidence.remoteDeployment);
  if (forward?.deployment?.cutoverReexecuted !== false || forward?.deployment?.migrationsApplied !== false || forward?.deployment?.resourcesCreated !== false) {
    throw new Error("G32 C2 attempted to repeat the one-time cutover");
  }
  if (
    forward?.runtimeDigestComparison?.initialRuntimeDigest !== evidence.treeDigests.runtime ||
    forward?.runtimeDigestComparison?.c2RuntimeDigest !== forward.treeDigests.runtime ||
    forward?.runtimeDigestComparison?.unchanged !== true ||
    forward?.deploymentConfig?.digest !== evidence.deploymentConfig.digest
  ) throw new Error("G32 C2 must record unchanged runtime/deployment digest");
  const post = forward?.postWitness;
  if (
    post?.primary?.sourceCommit !== candidate || post?.receiver?.sourceCommit !== candidate ||
    post?.rawV1?.status !== 404 || post?.staleBridgeRoute?.status !== 404 ||
    post?.primary?.sortableUniqueId?.digits !== 30 || post?.receiver?.sortableUniqueId?.digits !== 30 ||
    post?.primary?.sortableUniqueId?.legacyUnsupported !== true || post?.receiver?.sortableUniqueId?.legacyUnsupported !== true ||
    post?.primary?.eventRecord?.eventType !== "eventPayloadName" || post?.receiver?.eventRecord?.eventType !== "eventPayloadName"
  ) throw new Error("G32 C2 post-witness lacks C2 identity / 30-digit ingress proof");
  if (forward?.queueTopology?.primaryExclusive !== true || forward?.queueTopology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 C2 Queue topology was not preserved");
  }
  const preservation = forward?.dataPreservation;
  if (
    preservation?.status !== "preserved-existing-g32-data" || preservation?.stable !== true ||
    !SHA256.test(preservation?.preSetDigest) || !Number.isSafeInteger(preservation?.preserved?.reservationListEntries) ||
    preservation.preserved.reservationListEntries < 1
  ) throw new Error("G32 C2 needs a preserved post-cutover data witness");
  const latency = forward?.fixedNMeasurement?.latency;
  const stale = latency?.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (
    latency?.sampleCount !== cutover.final.fixedSamples || latency?.samples?.length !== cutover.final.fixedSamples ||
    latency?.rawV1?.status !== 404 || stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch" ||
    latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)
  ) throw new Error("G32 C2 N=10 / ingress evidence is incomplete");
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + cutover.final.fixedSamples * 2 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + cutover.final.fixedSamples * 2 ||
    latency?.finalStoreState?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 C2 measurement does not preserve then extend the post-cutover store");
  const audit = forward?.legacyIngressAudit;
  if (audit?.conclusion !== "all executable positive G32 ingress fixtures are 30-digit/UUIDv7/fixed-g32; legacy forms are retained only as typed zero-call negatives" ||
    !Array.isArray(audit?.legacyNegative) || !audit.legacyNegative.includes("eventPayloadVersion")) {
    throw new Error("G32 C2 legacy ingress audit evidence is incomplete");
  }
  return { checked: true, sourceCommit: candidate, preservedEvents: beforeEvents, finalEvents: Number(latency.finalStoreState.eventCount) };
}

function assertC3Protocol(c3) {
  if (
    c3?.protocol?.selfReference !== false || c3?.protocol?.deploymentRequired !== true ||
    c3?.protocol?.forwardOnly !== true || c3?.protocol?.cutoverReexecuted !== false ||
    c3?.candidateImpact?.deploymentRequired !== true || c3?.candidateImpact?.newServiceId !== false ||
    c3?.candidateImpact?.newD1Database !== false || c3?.candidateImpact?.wipe !== false
  ) throw new Error("G32 C3 protocol must be deployment-required forward-only without another cutover/wipe");
  if (
    c3?.history?.initialCandidate !== INITIAL_CANDIDATE ||
    c3?.history?.initialEvidenceCommit !== INITIAL_EVIDENCE_COMMIT ||
    c3?.history?.c2Candidate !== C2_CANDIDATE || c3?.history?.c2EvidenceCommit !== C2_EVIDENCE_COMMIT ||
    c3?.history?.initialCutover !== "completed-once" ||
    c3?.history?.rejectedPreparedCandidate !== REJECTED_FORWARD_PREFLIGHT_CANDIDATE ||
    c3?.history?.rejectedPreparedCandidateRemoteEffects !== "none-before-wrangler"
  ) throw new Error("G32 C3 must retain C1/R1 and C2/R2 history");
}

export function assertC3EvidenceShape(c3, manifest) {
  const candidate = c3?.candidateCommit;
  if (candidate !== "CANDIDATE" && !SHA.test(candidate)) throw new Error("G32 C3 candidateCommit is invalid");
  if (candidate !== "CANDIDATE" && candidate !== C3_CANDIDATE) throw new Error("G32 historical C3 candidate changed");
  if (c3?.sourceCommit !== candidate) throw new Error("G32 C3 sourceCommit must equal candidateCommit");
  assertC3Protocol(c3);
  assertDigestShape(c3?.treeDigests, manifest, "G32 C3", candidate === "CANDIDATE");
  if (c3?.deploymentConfig?.algorithm !== DIGEST_ALGORITHM || !same(c3?.deploymentConfig?.paths, G32_DEPLOYMENT_CONFIG_PATHS)) {
    throw new Error("G32 C3 deployment config declaration is invalid");
  }
  if (candidate !== "CANDIDATE") {
    if (
      digestAtCommit(candidate, manifest.runtimeRoots) !== c3.treeDigests.runtime ||
      digestAtCommit(candidate, manifest.configurationRoots) !== c3.treeDigests.configuration ||
      deploymentConfigDigest(candidate) !== c3.deploymentConfig.digest
    ) throw new Error("G32 C3 candidate digest mismatch");
  }
  return { candidateCommit: candidate, digestChecked: candidate !== "CANDIDATE" };
}

/** C3 has real runtime fixes, so both deployment and runtime digests must change from C2. */
export function assertC3DeploymentIdentity(evidence, cutover) {
  const c2 = forwardOf(evidence);
  const c3 = c3Of(evidence);
  if (c3.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const candidate = c3.candidateCommit;
  const remote = c3?.remoteDeployment;
  if (remote?.sourceCommit !== candidate || remote?.deployedRuntimeCommit !== candidate) throw new Error("G32 C3 deployedRuntimeCommit/sourceCommit mismatch");
  assertSameBindings(remote, c2.remoteDeployment);
  if (c3?.deployment?.cutoverReexecuted !== false || c3?.deployment?.migrationsApplied !== false || c3?.deployment?.resourcesCreated !== false) {
    throw new Error("G32 C3 attempted to repeat the one-time cutover");
  }
  if (
    c3?.runtimeDigestComparison?.c2RuntimeDigest !== c2.treeDigests.runtime ||
    c3?.runtimeDigestComparison?.c3RuntimeDigest !== c3.treeDigests.runtime ||
    c3?.runtimeDigestComparison?.c2DeploymentConfigDigest !== c2.deploymentConfig.digest ||
    c3?.runtimeDigestComparison?.c3DeploymentConfigDigest !== c3.deploymentConfig.digest ||
    c3?.runtimeDigestComparison?.changed !== true ||
    c3.treeDigests.runtime === c2.treeDigests.runtime ||
    c3.deploymentConfig.digest === c2.deploymentConfig.digest
  ) throw new Error("G32 C3 must record the real runtime/deployment digest change from C2");
  const post = c3?.postWitness;
  if (
    post?.primary?.sourceCommit !== candidate || post?.receiver?.sourceCommit !== candidate ||
    post?.rawV1?.status !== 404 || post?.staleBridgeRoute?.status !== 404 ||
    post?.primary?.sortableUniqueId?.digits !== 30 || post?.receiver?.sortableUniqueId?.digits !== 30 ||
    post?.primary?.sortableUniqueId?.legacyUnsupported !== true || post?.receiver?.sortableUniqueId?.legacyUnsupported !== true ||
    post?.primary?.eventRecord?.eventType !== "eventPayloadName" || post?.receiver?.eventRecord?.eventType !== "eventPayloadName"
  ) throw new Error("G32 C3 post-witness lacks C3 identity / 30-digit ingress proof");
  if (c3?.queueTopology?.primaryExclusive !== true || c3?.queueTopology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 C3 Queue topology was not preserved");
  }
  const preservation = c3?.dataPreservation;
  if (
    preservation?.status !== "preserved-existing-g32-data" || preservation?.stable !== true ||
    !SHA256.test(preservation?.preSetDigest) || !Number.isSafeInteger(preservation?.preserved?.reservationListEntries) ||
    preservation.preserved.reservationListEntries < 1
  ) throw new Error("G32 C3 needs a preserved post-C2 data witness");
  const latency = c3?.fixedNMeasurement?.latency;
  const stale = latency?.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (
    latency?.sampleCount !== cutover.final.fixedSamples || latency?.samples?.length !== cutover.final.fixedSamples ||
    latency?.rawV1?.status !== 404 || stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch" ||
    latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)
  ) throw new Error("G32 C3 N=10 / ingress evidence is incomplete");
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + cutover.final.fixedSamples * 2 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + cutover.final.fixedSamples * 2 ||
    latency?.finalStoreState?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 C3 measurement does not preserve then extend the post-C2 store");
  const audit = c3?.legacyIngressAudit;
  if (audit?.conclusion !== "all executable positive G32 ingress fixtures are 30-digit/UUIDv7/fixed-g32; legacy forms are retained only as typed zero-call negatives" ||
    !Array.isArray(audit?.legacyNegative) || !audit.legacyNegative.includes("eventPayloadVersion")) {
    throw new Error("G32 C3 legacy ingress audit evidence is incomplete");
  }
  return { checked: true, sourceCommit: candidate, preservedEvents: beforeEvents, finalEvents: Number(latency.finalStoreState.eventCount) };
}

function assertC4Protocol(c4) {
  if (
    c4?.protocol?.selfReference !== false || c4?.protocol?.deploymentRequired !== true ||
    c4?.protocol?.forwardOnly !== true || c4?.protocol?.cutoverReexecuted !== false ||
    c4?.candidateImpact?.deploymentRequired !== true || c4?.candidateImpact?.newServiceId !== false ||
    c4?.candidateImpact?.newD1Database !== false || c4?.candidateImpact?.wipe !== false
  ) throw new Error("G32 C4 protocol must be deployment-required forward-only without another cutover/wipe");
  if (
    c4?.history?.initialCandidate !== INITIAL_CANDIDATE ||
    c4?.history?.initialEvidenceCommit !== INITIAL_EVIDENCE_COMMIT ||
    c4?.history?.c2Candidate !== C2_CANDIDATE || c4?.history?.c2EvidenceCommit !== C2_EVIDENCE_COMMIT ||
    c4?.history?.c3Candidate !== C3_CANDIDATE || c4?.history?.c3EvidenceCommit !== C3_EVIDENCE_COMMIT ||
    c4?.history?.initialCutover !== "completed-once"
  ) throw new Error("G32 C4 must retain C1/R1, C2/R2, and C3/R3 history");
}

/** C4 uses the required-root manifest itself as the only root authority. */
export function assertC4EvidenceShape(c4, manifest) {
  const candidate = c4?.candidateCommit;
  if (candidate !== "CANDIDATE" && !SHA.test(candidate)) throw new Error("G32 C4 candidateCommit is invalid");
  if (c4?.sourceCommit !== candidate) throw new Error("G32 C4 sourceCommit must equal candidateCommit");
  assertC4Protocol(c4);
  const tree = c4?.treeDigests;
  if (tree?.algorithm !== DIGEST_ALGORITHM || tree?.manifest !== "docs/SDT-G32-required-roots.json") {
    throw new Error("G32 C4 digest manifest authority is invalid");
  }
  for (const field of ["runtime", "configuration"]) {
    const value = tree?.[field];
    if (candidate === "CANDIDATE" && (value === "0".repeat(64) || value === "1".repeat(64))) continue;
    assertSha256(value, `G32 C4 ${field}`);
  }
  if (c4?.deploymentConfig?.algorithm !== DIGEST_ALGORITHM || !same(c4?.deploymentConfig?.paths, G32_DEPLOYMENT_CONFIG_PATHS)) {
    throw new Error("G32 C4 deployment config declaration is invalid");
  }
  const deployment = c4?.deploymentConfig?.digest;
  if (!(candidate === "CANDIDATE" && deployment === "2".repeat(64))) assertSha256(deployment, "G32 C4 deployment config");
  if (candidate !== "CANDIDATE") {
    if (
      digestAtCommit(candidate, manifest.runtimeRoots) !== tree.runtime ||
      digestAtCommit(candidate, manifest.configurationRoots) !== tree.configuration ||
      deploymentConfigDigest(candidate) !== deployment
    ) throw new Error("G32 C4 candidate digest mismatch");
  }
  return { candidateCommit: candidate, digestChecked: candidate !== "CANDIDATE" };
}

/** C4 repairs test-runner loading only, so runtime and deployment bytes remain C3-identical. */
export function assertC4DeploymentIdentity(evidence, cutover) {
  const c3 = c3Of(evidence);
  const c4 = c4Of(evidence);
  if (c4.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const candidate = c4.candidateCommit;
  const remote = c4?.remoteDeployment;
  if (remote?.sourceCommit !== candidate || remote?.deployedRuntimeCommit !== candidate) throw new Error("G32 C4 deployedRuntimeCommit/sourceCommit mismatch");
  assertSameBindings(remote, c3.remoteDeployment);
  if (c4?.deployment?.cutoverReexecuted !== false || c4?.deployment?.migrationsApplied !== false || c4?.deployment?.resourcesCreated !== false) {
    throw new Error("G32 C4 attempted to repeat the one-time cutover");
  }
  if (
    c4?.runtimeDigestComparison?.c3RuntimeDigest !== c3.treeDigests.runtime ||
    c4?.runtimeDigestComparison?.c4RuntimeDigest !== c4.treeDigests.runtime ||
    c4?.runtimeDigestComparison?.c3DeploymentConfigDigest !== c3.deploymentConfig.digest ||
    c4?.runtimeDigestComparison?.c4DeploymentConfigDigest !== c4.deploymentConfig.digest ||
    c4?.runtimeDigestComparison?.runtimeUnchanged !== true ||
    c4?.runtimeDigestComparison?.deploymentConfigUnchanged !== true ||
    c4.treeDigests.runtime !== c3.treeDigests.runtime ||
    c4.deploymentConfig.digest !== c3.deploymentConfig.digest ||
    c4.treeDigests.configuration === c3.treeDigests.configuration
  ) throw new Error("G32 C4 must prove test-only runtime/config attribution");
  const post = c4?.postWitness;
  if (
    post?.primary?.sourceCommit !== candidate || post?.receiver?.sourceCommit !== candidate ||
    post?.rawV1?.status !== 404 || post?.staleBridgeRoute?.status !== 404 ||
    post?.primary?.sortableUniqueId?.digits !== 30 || post?.receiver?.sortableUniqueId?.digits !== 30 ||
    post?.primary?.sortableUniqueId?.legacyUnsupported !== true || post?.receiver?.sortableUniqueId?.legacyUnsupported !== true ||
    post?.primary?.eventRecord?.eventType !== "eventPayloadName" || post?.receiver?.eventRecord?.eventType !== "eventPayloadName"
  ) throw new Error("G32 C4 post-witness lacks C4 identity / 30-digit ingress proof");
  if (c4?.queueTopology?.primaryExclusive !== true || c4?.queueTopology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 C4 Queue topology was not preserved");
  }
  const preservation = c4?.dataPreservation;
  if (
    preservation?.status !== "preserved-existing-g32-data" || preservation?.stable !== true ||
    !SHA256.test(preservation?.preSetDigest) || !Number.isSafeInteger(preservation?.preserved?.reservationListEntries) ||
    preservation.preserved.reservationListEntries < 1
  ) throw new Error("G32 C4 needs a preserved post-C3 data witness");
  const latency = c4?.fixedNMeasurement?.latency;
  const stale = latency?.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (
    latency?.sampleCount !== cutover.final.fixedSamples || latency?.samples?.length !== cutover.final.fixedSamples ||
    latency?.rawV1?.status !== 404 || stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch" ||
    latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)
  ) throw new Error("G32 C4 N=10 / ingress evidence is incomplete");
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + cutover.final.fixedSamples * 2 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + cutover.final.fixedSamples * 2 ||
    latency?.finalStoreState?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 C4 measurement does not preserve then extend the post-C3 store");
  const audit = c4?.legacyIngressAudit;
  if (audit?.conclusion !== "all executable positive G32 ingress fixtures are 30-digit/UUIDv7/fixed-g32; legacy forms are retained only as typed zero-call negatives" ||
    !Array.isArray(audit?.legacyNegative) || !audit.legacyNegative.includes("eventPayloadVersion")) {
    throw new Error("G32 C4 legacy ingress audit evidence is incomplete");
  }
  return { checked: true, sourceCommit: candidate, preservedEvents: beforeEvents, finalEvents: Number(latency.finalStoreState.eventCount) };
}

function assertC5Protocol(c5) {
  if (
    c5?.protocol?.selfReference !== false || c5?.protocol?.deploymentRequired !== true ||
    c5?.protocol?.forwardOnly !== true || c5?.protocol?.cutoverReexecuted !== false ||
    c5?.candidateImpact?.deploymentRequired !== true || c5?.candidateImpact?.newServiceId !== false ||
    c5?.candidateImpact?.newD1Database !== false || c5?.candidateImpact?.wipe !== false
  ) throw new Error("G32 C5 protocol must be deployment-required forward-only without another cutover/wipe");
  if (
    c5?.history?.initialCandidate !== INITIAL_CANDIDATE ||
    c5?.history?.initialEvidenceCommit !== INITIAL_EVIDENCE_COMMIT ||
    c5?.history?.c2Candidate !== C2_CANDIDATE || c5?.history?.c2EvidenceCommit !== C2_EVIDENCE_COMMIT ||
    c5?.history?.c3Candidate !== C3_CANDIDATE || c5?.history?.c3EvidenceCommit !== C3_EVIDENCE_COMMIT ||
    c5?.history?.c4Candidate !== C4_CANDIDATE || c5?.history?.c4EvidenceCommit !== C4_EVIDENCE_COMMIT ||
    c5?.history?.initialCutover !== "completed-once"
  ) throw new Error("G32 C5 must retain C1/R1 through C4/R4 history");
}

/** C5 repairs the C# runner's JSON transport while retaining C4 runtime/config bytes. */
export function assertC5EvidenceShape(c5, manifest) {
  const candidate = c5?.candidateCommit;
  if (candidate !== "CANDIDATE" && !SHA.test(candidate)) throw new Error("G32 C5 candidateCommit is invalid");
  if (c5?.sourceCommit !== candidate) throw new Error("G32 C5 sourceCommit must equal candidateCommit");
  assertC5Protocol(c5);
  const tree = c5?.treeDigests;
  if (tree?.algorithm !== DIGEST_ALGORITHM || tree?.manifest !== "docs/SDT-G32-required-roots.json") {
    throw new Error("G32 C5 digest manifest authority is invalid");
  }
  for (const field of ["runtime", "configuration"]) {
    const value = tree?.[field];
    if (candidate === "CANDIDATE" && (value === "0".repeat(64) || value === "1".repeat(64))) continue;
    assertSha256(value, `G32 C5 ${field}`);
  }
  if (c5?.deploymentConfig?.algorithm !== DIGEST_ALGORITHM || !same(c5?.deploymentConfig?.paths, G32_DEPLOYMENT_CONFIG_PATHS)) {
    throw new Error("G32 C5 deployment config declaration is invalid");
  }
  const deployment = c5?.deploymentConfig?.digest;
  if (!(candidate === "CANDIDATE" && deployment === "2".repeat(64))) assertSha256(deployment, "G32 C5 deployment config");
  if (candidate !== "CANDIDATE") {
    if (
      digestAtCommit(candidate, manifest.runtimeRoots) !== tree.runtime ||
      digestAtCommit(candidate, manifest.configurationRoots) !== tree.configuration ||
      deploymentConfigDigest(candidate) !== deployment
    ) throw new Error("G32 C5 candidate digest mismatch");
  }
  return { candidateCommit: candidate, digestChecked: candidate !== "CANDIDATE" };
}

export function assertC5DeploymentIdentity(evidence, cutover) {
  const c4 = c4Of(evidence);
  const c5 = c5Of(evidence);
  if (c5.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const candidate = c5.candidateCommit;
  const remote = c5?.remoteDeployment;
  if (remote?.sourceCommit !== candidate || remote?.deployedRuntimeCommit !== candidate) throw new Error("G32 C5 deployedRuntimeCommit/sourceCommit mismatch");
  assertSameBindings(remote, c4.remoteDeployment);
  if (c5?.deployment?.cutoverReexecuted !== false || c5?.deployment?.migrationsApplied !== false || c5?.deployment?.resourcesCreated !== false) {
    throw new Error("G32 C5 attempted to repeat the one-time cutover");
  }
  if (
    c5?.runtimeDigestComparison?.c4RuntimeDigest !== c4.treeDigests.runtime ||
    c5?.runtimeDigestComparison?.c5RuntimeDigest !== c5.treeDigests.runtime ||
    c5?.runtimeDigestComparison?.c4DeploymentConfigDigest !== c4.deploymentConfig.digest ||
    c5?.runtimeDigestComparison?.c5DeploymentConfigDigest !== c5.deploymentConfig.digest ||
    c5?.runtimeDigestComparison?.runtimeUnchanged !== true ||
    c5?.runtimeDigestComparison?.deploymentConfigUnchanged !== true ||
    c5?.runnerTransport?.buildSeparatedFromJsonStdout !== true ||
    c5.treeDigests.runtime !== c4.treeDigests.runtime ||
    c5.deploymentConfig.digest !== c4.deploymentConfig.digest ||
    c5.treeDigests.configuration === c4.treeDigests.configuration
  ) throw new Error("G32 C5 must prove C# JSON-transport-only runtime/config attribution");
  const post = c5?.postWitness;
  if (
    post?.primary?.sourceCommit !== candidate || post?.receiver?.sourceCommit !== candidate ||
    post?.rawV1?.status !== 404 || post?.staleBridgeRoute?.status !== 404 ||
    post?.primary?.sortableUniqueId?.digits !== 30 || post?.receiver?.sortableUniqueId?.digits !== 30 ||
    post?.primary?.sortableUniqueId?.legacyUnsupported !== true || post?.receiver?.sortableUniqueId?.legacyUnsupported !== true ||
    post?.primary?.eventRecord?.eventType !== "eventPayloadName" || post?.receiver?.eventRecord?.eventType !== "eventPayloadName"
  ) throw new Error("G32 C5 post-witness lacks C5 identity / 30-digit ingress proof");
  if (c5?.queueTopology?.primaryExclusive !== true || c5?.queueTopology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 C5 Queue topology was not preserved");
  }
  const preservation = c5?.dataPreservation;
  if (
    preservation?.status !== "preserved-existing-g32-data" || preservation?.stable !== true ||
    !SHA256.test(preservation?.preSetDigest) || !Number.isSafeInteger(preservation?.preserved?.reservationListEntries) ||
    preservation.preserved.reservationListEntries < 1
  ) throw new Error("G32 C5 needs a preserved post-C4 data witness");
  const latency = c5?.fixedNMeasurement?.latency;
  const stale = latency?.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (
    latency?.sampleCount !== cutover.final.fixedSamples || latency?.samples?.length !== cutover.final.fixedSamples ||
    latency?.rawV1?.status !== 404 || stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch" ||
    latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)
  ) throw new Error("G32 C5 N=10 / ingress evidence is incomplete");
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + cutover.final.fixedSamples * 2 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + cutover.final.fixedSamples * 2 ||
    latency?.finalStoreState?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 C5 measurement does not preserve then extend the post-C4 store");
  const audit = c5?.legacyIngressAudit;
  if (audit?.conclusion !== "all executable positive G32 ingress fixtures are 30-digit/UUIDv7/fixed-g32; legacy forms are retained only as typed zero-call negatives" ||
    !Array.isArray(audit?.legacyNegative) || !audit.legacyNegative.includes("eventPayloadVersion")) {
    throw new Error("G32 C5 legacy ingress audit evidence is incomplete");
  }
  return { checked: true, sourceCommit: candidate, preservedEvents: beforeEvents, finalEvents: Number(latency.finalStoreState.eventCount) };
}

export function assertPostCandidatePaths(paths, candidate, run = (args) => git(args)) {
  if (candidate === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const unsupported = paths.filter((path) => !R_PATHS.includes(path));
  if (unsupported.length > 0) throw new Error(`G32 post-candidate paths not allowlisted: ${unsupported.join(",")}`);
  if (!same([...paths].sort(), [...R_PATHS].sort())) throw new Error("G32 R must contain exactly evidence and one retained-C append");
  const diff = String(run(["diff", "--unified=0", `${candidate}..HEAD`, "--", ".github/workflows/ci.yml"]));
  const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== candidate) {
    throw new Error("G32 retained-candidate list must append exactly the active candidate once");
  }
  return { checked: true };
}

export function assertPreparedCandidate(candidate, evidence, manifest) {
  assertSha(candidate, "G32 C3 prepared candidate");
  const c2 = forwardOf(evidence);
  const c3 = c3Of(evidence);
  if (c2.candidateCommit !== C2_CANDIDATE || c2.sourceCommit !== C2_CANDIDATE) {
    throw new Error("G32 prepared C3 must retain actual C2 evidence");
  }
  if (c3.candidateCommit !== "CANDIDATE" || c3.sourceCommit !== "CANDIDATE") {
    throw new Error("G32 prepared C3 must retain its non-self-referential evidence placeholder");
  }
  assertC3EvidenceShape(c3, manifest);
  const material = assertCandidateMaterialCoverage(candidate, manifest);
  const runtime = digestAtCommit(candidate, manifest.runtimeRoots);
  const configuration = digestAtCommit(candidate, manifest.configurationRoots);
  const deployment = deploymentConfigDigest(candidate);
  if (runtime === c2.treeDigests.runtime || deployment === c2.deploymentConfig.digest) {
    throw new Error("G32 C3 must contain the reviewed runtime correction, not a vacuous C2-equivalent redeploy");
  }
  return { candidate, material, runtime, configuration, deploymentConfig: deployment, runtimeChangedFromC2: true };
}

export function assertPreparedC4Candidate(candidate, evidence, manifest) {
  assertSha(candidate, "G32 C4 prepared candidate");
  const c3 = c3Of(evidence);
  const c4 = c4Of(evidence);
  if (c3.candidateCommit !== C3_CANDIDATE || c3.sourceCommit !== C3_CANDIDATE) {
    throw new Error("G32 prepared C4 must retain actual C3 evidence");
  }
  if (c4.candidateCommit !== "CANDIDATE" || c4.sourceCommit !== "CANDIDATE") {
    throw new Error("G32 prepared C4 must retain its non-self-referential evidence placeholder");
  }
  assertC4EvidenceShape(c4, manifest);
  const material = assertCandidateMaterialCoverage(candidate, manifest);
  const runtime = digestAtCommit(candidate, manifest.runtimeRoots);
  const configuration = digestAtCommit(candidate, manifest.configurationRoots);
  const deployment = deploymentConfigDigest(candidate);
  if (runtime !== c3.treeDigests.runtime || deployment !== c3.deploymentConfig.digest || configuration === c3.treeDigests.configuration) {
    throw new Error("G32 C4 must be a real Worker-import/configuration repair with C3-identical runtime/deployment bytes");
  }
  return { candidate, material, runtime, configuration, deploymentConfig: deployment, runtimeUnchangedFromC3: true, deploymentConfigUnchangedFromC3: true };
}

export function assertPreparedC5Candidate(candidate, evidence, manifest) {
  assertSha(candidate, "G32 C5 prepared candidate");
  const c4 = c4Of(evidence);
  const c5 = c5Of(evidence);
  if (c4.candidateCommit !== C4_CANDIDATE || c4.sourceCommit !== C4_CANDIDATE) {
    throw new Error("G32 prepared C5 must retain actual C4 evidence");
  }
  if (c5.candidateCommit !== "CANDIDATE" || c5.sourceCommit !== "CANDIDATE") {
    throw new Error("G32 prepared C5 must retain its non-self-referential evidence placeholder");
  }
  assertC5EvidenceShape(c5, manifest);
  const material = assertCandidateMaterialCoverage(candidate, manifest);
  const runtime = digestAtCommit(candidate, manifest.runtimeRoots);
  const configuration = digestAtCommit(candidate, manifest.configurationRoots);
  const deployment = deploymentConfigDigest(candidate);
  if (runtime !== c4.treeDigests.runtime || deployment !== c4.deploymentConfig.digest || configuration === c4.treeDigests.configuration) {
    throw new Error("G32 C5 must be a real C# JSON-transport/configuration repair with C4-identical runtime/deployment bytes");
  }
  return { candidate, material, runtime, configuration, deploymentConfig: deployment, runtimeUnchangedFromC4: true, deploymentConfigUnchangedFromC4: true };
}

export function runSelfTest() {
  const manifest = loadManifest();
  const paths = [...new Set([...manifest.runtimeRoots, ...manifest.configurationRoots, ...manifest.requiredRoots.map((entry) => entry.path)])];
  assertDeclaredRoots(manifest, paths);
  assertRequiredRoots(manifest, paths);
  let missingRootRed = false;
  try { assertRequiredRoots(manifest, paths.filter((path) => path !== manifest.requiredRoots[0].path)); } catch (error) { missingRootRed = String(error).includes(":missing-file"); }
  if (!missingRootRed) throw new Error("G32 required-root removal mutation unexpectedly passed");
  let selfAuthorizedRed = false;
  try { loadManifest(() => JSON.stringify({ ...manifest, postCandidateOperationalRecoveryPaths: ["scripts/deploy/g32-forward-redeploy.sh"] })); } catch (error) { selfAuthorizedRed = String(error).includes("must not self-authorize"); }
  if (!selfAuthorizedRed) throw new Error("G32 self-authorized recovery mutation unexpectedly passed");
  const candidate = "c".repeat(40);
  assertCandidateMaterialCoverage(candidate, manifest, (args) => args[0] === "rev-parse" ? `${"p".repeat(40)}\n` : "scripts/g22-bootstrap-cosmos-contract.mjs\nscripts/deploy/g32-forward-redeploy.sh\n");
  let coverageRed = false;
  try { assertCandidateMaterialCoverage(candidate, manifest, (args) => args[0] === "rev-parse" ? `${"p".repeat(40)}\n` : "outside-g32-material.txt\n"); } catch (error) { coverageRed = String(error).includes("outside manifest roots"); }
  if (!coverageRed) throw new Error("G32 undeclared candidate material mutation unexpectedly passed");
  const forward = {
    candidateCommit: candidate, sourceCommit: candidate,
    protocol: { selfReference: false, deploymentRequired: true, forwardOnly: true, cutoverReexecuted: false },
    candidateImpact: { deploymentRequired: true, newServiceId: false, newD1Database: false, wipe: false },
    history: {
      initialCandidate: INITIAL_CANDIDATE,
      initialEvidenceCommit: INITIAL_EVIDENCE_COMMIT,
      initialCutover: "completed-once",
      rejectedPreparedCandidate: REJECTED_FORWARD_PREFLIGHT_CANDIDATE,
      rejectedPreparedCandidateRemoteEffects: "none-before-wrangler",
    },
    treeDigests: { algorithm: DIGEST_ALGORITHM, runtime: "b".repeat(64), runtimeRoots: manifest.runtimeRoots, configuration: "c".repeat(64), configurationRoots: manifest.configurationRoots },
    deploymentConfig: { digest: "d".repeat(64) },
  };
  let repeatCutoverRed = false;
  try { assertForwardProtocol({ ...forward, protocol: { ...forward.protocol, cutoverReexecuted: true } }); } catch (error) { repeatCutoverRed = String(error).includes("forward-only"); }
  if (!repeatCutoverRed) throw new Error("G32 repeat-cutover mutation unexpectedly passed");
  const final = {
    ...forward,
    remoteDeployment: { sourceCommit: candidate, deployedRuntimeCommit: candidate, worker: "primary", receiver: "receiver", serviceId: "service", pipelineDatabaseId: "pipeline", materializedViewDatabaseId: "mv", queue: "queue", deadLetterQueue: "dlq", durableObjectNamespaces: ["Tag"] },
    deployment: { cutoverReexecuted: false, migrationsApplied: false, resourcesCreated: false },
    runtimeDigestComparison: { initialRuntimeDigest: "a".repeat(64), c2RuntimeDigest: "b".repeat(64), unchanged: true },
    postWitness: { primary: { sourceCommit: candidate, sortableUniqueId: { digits: 30, legacyUnsupported: true }, eventRecord: { eventType: "eventPayloadName" } }, receiver: { sourceCommit: candidate, sortableUniqueId: { digits: 30, legacyUnsupported: true }, eventRecord: { eventType: "eventPayloadName" } }, rawV1: { status: 404 }, staleBridgeRoute: { status: 404 }, newStoreState: { eventCount: 20, eventOpsCount: 20 } },
    queueTopology: { primaryExclusive: true, receiverServiceBindingOnly: true },
    dataPreservation: { status: "preserved-existing-g32-data", stable: true, preSetDigest: "e".repeat(64), preserved: { reservationListEntries: 1 } },
    fixedNMeasurement: { latency: { sampleCount: 10, samples: Array.from({ length: 10 }), rawV1: { status: 404 }, staleNegatives: [{ id: "old-37-character-suid-list", status: 400, outcome: "typed-rejected-before-list-dispatch" }], fiveEndpointConformance: Array.from({ length: 5 }, () => ({ status: 200 })), finalStoreState: { eventCount: 40, eventOpsCount: 40, legacySerializedEventTablePresent: false } } },
    legacyIngressAudit: { conclusion: "all executable positive G32 ingress fixtures are 30-digit/UUIDv7/fixed-g32; legacy forms are retained only as typed zero-call negatives", legacyNegative: ["eventPayloadVersion"] },
  };
  const historical = { treeDigests: { runtime: "a".repeat(64) }, deploymentConfig: { digest: "d".repeat(64) }, remoteDeployment: { worker: "primary", receiver: "receiver", serviceId: "service", pipelineDatabaseId: "pipeline", materializedViewDatabaseId: "mv", queue: "queue", deadLetterQueue: "dlq", durableObjectNamespaces: ["Tag"] }, forwardRedeploy: final };
  assertForwardDeploymentIdentity(historical, { final: { fixedSamples: 10 } });
  let preservationRed = false;
  try { assertForwardDeploymentIdentity({ ...historical, forwardRedeploy: { ...final, dataPreservation: { ...final.dataPreservation, stable: false } } }, { final: { fixedSamples: 10 } }); } catch (error) { preservationRed = String(error).includes("preserved post-cutover"); }
  if (!preservationRed) throw new Error("G32 data-preservation mutation unexpectedly passed");
  let ingressRed = false;
  try { assertForwardDeploymentIdentity({ ...historical, forwardRedeploy: { ...final, postWitness: { ...final.postWitness, primary: { ...final.postWitness.primary, sortableUniqueId: { digits: 37, legacyUnsupported: true } } } } }, { final: { fixedSamples: 10 } }); } catch (error) { ingressRed = String(error).includes("30-digit ingress"); }
  if (!ingressRed) throw new Error("G32 ingress mutation unexpectedly passed");
  const c3 = {
    ...final,
    history: { ...final.history, c2Candidate: C2_CANDIDATE, c2EvidenceCommit: C2_EVIDENCE_COMMIT },
    treeDigests: { algorithm: DIGEST_ALGORITHM, runtime: "f".repeat(64), runtimeRoots: manifest.runtimeRoots, configuration: "g".repeat(64), configurationRoots: manifest.configurationRoots },
    deploymentConfig: { algorithm: DIGEST_ALGORITHM, digest: "h".repeat(64), paths: G32_DEPLOYMENT_CONFIG_PATHS },
    runtimeDigestComparison: { c2RuntimeDigest: "b".repeat(64), c3RuntimeDigest: "f".repeat(64), c2DeploymentConfigDigest: "d".repeat(64), c3DeploymentConfigDigest: "h".repeat(64), changed: true },
  };
  const c3Historical = { ...historical, forwardRedeployC3: c3 };
  assertC3DeploymentIdentity(c3Historical, { final: { fixedSamples: 10 } });
  let c3RuntimeRed = false;
  try { assertC3DeploymentIdentity({ ...c3Historical, forwardRedeployC3: { ...c3, treeDigests: { ...c3.treeDigests, runtime: "b".repeat(64) } } }, { final: { fixedSamples: 10 } }); } catch (error) { c3RuntimeRed = String(error).includes("runtime/deployment digest change"); }
  if (!c3RuntimeRed) throw new Error("G32 C3 runtime-digest attribution mutation unexpectedly passed");
  const c3Placeholder = {
    ...c3,
    candidateCommit: "CANDIDATE",
    sourceCommit: "CANDIDATE",
    treeDigests: { ...c3.treeDigests, runtime: "0".repeat(64), configuration: "1".repeat(64) },
    deploymentConfig: { ...c3.deploymentConfig, digest: "2".repeat(64) },
  };
  assertC3EvidenceShape(c3Placeholder, manifest);
  let c3RootsRed = false;
  try { assertC3EvidenceShape({ ...c3Placeholder, treeDigests: { ...c3Placeholder.treeDigests, configurationRoots: [] } }, manifest); } catch (error) { c3RootsRed = String(error).includes("digest roots"); }
  if (!c3RootsRed) throw new Error("G32 C3 root-manifest attribution mutation unexpectedly passed");
  const c4Placeholder = {
    candidateCommit: "CANDIDATE",
    sourceCommit: "CANDIDATE",
    protocol: { selfReference: false, deploymentRequired: true, forwardOnly: true, cutoverReexecuted: false },
    candidateImpact: { deploymentRequired: true, newServiceId: false, newD1Database: false, wipe: false },
    history: {
      initialCandidate: INITIAL_CANDIDATE,
      initialEvidenceCommit: INITIAL_EVIDENCE_COMMIT,
      initialCutover: "completed-once",
      c2Candidate: C2_CANDIDATE,
      c2EvidenceCommit: C2_EVIDENCE_COMMIT,
      c3Candidate: C3_CANDIDATE,
      c3EvidenceCommit: C3_EVIDENCE_COMMIT,
    },
    treeDigests: { algorithm: DIGEST_ALGORITHM, manifest: "docs/SDT-G32-required-roots.json", runtime: "0".repeat(64), configuration: "1".repeat(64) },
    deploymentConfig: { algorithm: DIGEST_ALGORITHM, digest: "2".repeat(64), paths: G32_DEPLOYMENT_CONFIG_PATHS },
  };
  assertC4EvidenceShape(c4Placeholder, manifest);
  let c4ManifestRed = false;
  try { assertC4EvidenceShape({ ...c4Placeholder, treeDigests: { ...c4Placeholder.treeDigests, manifest: "docs/other.json" } }, manifest); } catch (error) { c4ManifestRed = String(error).includes("manifest authority"); }
  if (!c4ManifestRed) throw new Error("G32 C4 manifest-authority mutation unexpectedly passed");
  const c4Candidate = "d".repeat(40);
  const c4 = {
    ...final,
    candidateCommit: c4Candidate,
    sourceCommit: c4Candidate,
    protocol: c4Placeholder.protocol,
    candidateImpact: { ...c4Placeholder.candidateImpact, candidateCommit: c4Candidate },
    history: c4Placeholder.history,
    treeDigests: { algorithm: DIGEST_ALGORITHM, manifest: "docs/SDT-G32-required-roots.json", runtime: c3.treeDigests.runtime, configuration: "i".repeat(64) },
    deploymentConfig: { algorithm: DIGEST_ALGORITHM, digest: c3.deploymentConfig.digest, paths: G32_DEPLOYMENT_CONFIG_PATHS },
    runtimeDigestComparison: { c3RuntimeDigest: c3.treeDigests.runtime, c4RuntimeDigest: c3.treeDigests.runtime, c3DeploymentConfigDigest: c3.deploymentConfig.digest, c4DeploymentConfigDigest: c3.deploymentConfig.digest, runtimeUnchanged: true, deploymentConfigUnchanged: true },
    remoteDeployment: { ...c3.remoteDeployment, sourceCommit: c4Candidate, deployedRuntimeCommit: c4Candidate },
    postWitness: {
      ...c3.postWitness,
      primary: { ...c3.postWitness.primary, sourceCommit: c4Candidate },
      receiver: { ...c3.postWitness.receiver, sourceCommit: c4Candidate },
      newStoreState: { eventCount: 40, eventOpsCount: 40 },
    },
    fixedNMeasurement: { latency: { ...c3.fixedNMeasurement.latency, finalStoreState: { eventCount: 60, eventOpsCount: 60, legacySerializedEventTablePresent: false } } },
  };
  const c4Historical = { ...historical, forwardRedeployC3: c3, forwardRedeployC4: c4 };
  assertC4DeploymentIdentity(c4Historical, { final: { fixedSamples: 10 } });
  let c4RuntimeRed = false;
  try { assertC4DeploymentIdentity({ ...c4Historical, forwardRedeployC4: { ...c4, treeDigests: { ...c4.treeDigests, runtime: "j".repeat(64) } } }, { final: { fixedSamples: 10 } }); } catch (error) { c4RuntimeRed = String(error).includes("test-only runtime/config attribution"); }
  if (!c4RuntimeRed) throw new Error("G32 C4 runtime-attribution mutation unexpectedly passed");
  const c5Placeholder = {
    ...c4Placeholder,
    history: {
      ...c4Placeholder.history,
      c4Candidate: C4_CANDIDATE,
      c4EvidenceCommit: C4_EVIDENCE_COMMIT,
    },
  };
  assertC5EvidenceShape(c5Placeholder, manifest);
  let c5ManifestRed = false;
  try { assertC5EvidenceShape({ ...c5Placeholder, treeDigests: { ...c5Placeholder.treeDigests, manifest: "docs/other.json" } }, manifest); } catch (error) { c5ManifestRed = String(error).includes("manifest authority"); }
  if (!c5ManifestRed) throw new Error("G32 C5 manifest-authority mutation unexpectedly passed");
  const c5Candidate = "e".repeat(40);
  const c5 = {
    ...c4,
    candidateCommit: c5Candidate,
    sourceCommit: c5Candidate,
    protocol: c5Placeholder.protocol,
    candidateImpact: { ...c5Placeholder.candidateImpact, candidateCommit: c5Candidate },
    history: c5Placeholder.history,
    treeDigests: { algorithm: DIGEST_ALGORITHM, manifest: "docs/SDT-G32-required-roots.json", runtime: c4.treeDigests.runtime, configuration: "e".repeat(64) },
    deploymentConfig: { algorithm: DIGEST_ALGORITHM, digest: c4.deploymentConfig.digest, paths: G32_DEPLOYMENT_CONFIG_PATHS },
    runtimeDigestComparison: { c4RuntimeDigest: c4.treeDigests.runtime, c5RuntimeDigest: c4.treeDigests.runtime, c4DeploymentConfigDigest: c4.deploymentConfig.digest, c5DeploymentConfigDigest: c4.deploymentConfig.digest, runtimeUnchanged: true, deploymentConfigUnchanged: true },
    runnerTransport: { buildSeparatedFromJsonStdout: true },
    remoteDeployment: { ...c4.remoteDeployment, sourceCommit: c5Candidate, deployedRuntimeCommit: c5Candidate },
    postWitness: {
      ...c4.postWitness,
      primary: { ...c4.postWitness.primary, sourceCommit: c5Candidate },
      receiver: { ...c4.postWitness.receiver, sourceCommit: c5Candidate },
      newStoreState: { eventCount: 60, eventOpsCount: 60 },
    },
    fixedNMeasurement: { latency: { ...c4.fixedNMeasurement.latency, finalStoreState: { eventCount: 80, eventOpsCount: 80, legacySerializedEventTablePresent: false } } },
  };
  const c5Historical = { ...historical, forwardRedeployC3: c3, forwardRedeployC4: c4, forwardRedeployC5: c5 };
  assertC5DeploymentIdentity(c5Historical, { final: { fixedSamples: 10 } });
  let c5RunnerRed = false;
  try { assertC5DeploymentIdentity({ ...c5Historical, forwardRedeployC5: { ...c5, runnerTransport: { buildSeparatedFromJsonStdout: false } } }, { final: { fixedSamples: 10 } }); } catch (error) { c5RunnerRed = String(error).includes("JSON-transport-only"); }
  if (!c5RunnerRed) throw new Error("G32 C5 runner-transport attribution mutation unexpectedly passed");
  assertPostCandidatePaths([...R_PATHS], candidate, () => `+${candidate}\n`);
  let postPathRed = false;
  try { assertPostCandidatePaths([...R_PATHS, "scripts/deploy/g32-forward-redeploy.sh"], candidate, () => `+${candidate}\n`); } catch (error) { postPathRed = String(error).includes("not allowlisted"); }
  if (!postPathRed) throw new Error("G32 post-C operational edit mutation unexpectedly passed");
  return { declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length, requiredRoots: manifest.requiredRoots.length, mutations: ["missing-root", "self-authorized-post-c", "undeclared-material", "repeat-cutover", "data-preservation", "30-digit-ingress", "c3-runtime-digest", "c3-root-manifest", "c4-manifest-authority", "c4-runtime-attribution", "c5-manifest-authority", "c5-runner-transport-attribution", "post-c-operational-edit"] };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main() {
  if (process.env.SDT_G32_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G32 candidate gate forced failure");
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
    return;
  }
  const manifest = loadManifest();
  const evidence = readJson(evidencePath);
  const cutover = readJson(cutoverPath);
  const history = assertInitialCutoverHistory(evidence, cutover);
  const c3History = assertC3EvidenceCommit();
  const forward = assertForwardEvidenceShape(forwardOf(evidence));
  const c2Deployment = assertForwardDeploymentIdentity(evidence, cutover);
  const c3 = assertC3EvidenceShape(c3Of(evidence), manifest);
  const c3Deployment = assertC3DeploymentIdentity(evidence, cutover);
  const c4 = assertC4EvidenceShape(c4Of(evidence), manifest);
  const c4Deployment = assertC4DeploymentIdentity(evidence, cutover);
  const c5 = assertC5EvidenceShape(c5Of(evidence), manifest);
  const c5Deployment = assertC5DeploymentIdentity(evidence, cutover);
  const declared = assertDeclaredRoots(manifest);
  const required = assertRequiredRoots(manifest);
  const candidateArgument = argument("--candidate");
  if (candidateArgument !== undefined) {
    if (gitText(["rev-parse", "HEAD"]).trim() !== candidateArgument) throw new Error("G32 prepared candidate must equal checked-out HEAD");
    if (c5.candidateCommit !== "CANDIDATE") throw new Error("G32 C5 prepared candidate requires its non-self-referential placeholder");
    console.log(JSON.stringify({ history: { ...history, c3: c3History }, c2: { forward, deployment: c2Deployment }, c3: { evidence: c3, deployment: c3Deployment }, c4: { evidence: c4, deployment: c4Deployment }, c5: { evidence: c5, deployment: c5Deployment }, manifest: { ...declared, ...required }, prepared: assertPreparedC5Candidate(candidateArgument, evidence, manifest) }, null, 2));
    return;
  }
  const candidate = c5.candidateCommit;
  const active = candidate !== "CANDIDATE" && SHA.test(candidate) && (() => {
    try { git(["merge-base", "--is-ancestor", candidate, "HEAD"]); return true; } catch { return false; }
  })();
  const post = active
    ? assertPostCandidatePaths(gitText(["diff", "--name-only", `${candidate}..HEAD`]).split(/\r?\n/).filter(Boolean), candidate)
    : { checked: false, reason: candidate === "CANDIDATE" ? "placeholder-candidate" : "candidate-not-ancestor" };
  console.log(JSON.stringify({ history: { ...history, c3: c3History }, c2: { forward, deployment: c2Deployment }, c3: { evidence: c3, deployment: c3Deployment }, c4: { evidence: c4, deployment: c4Deployment }, c5: { evidence: c5, deployment: c5Deployment }, manifest: { ...declared, ...required }, postCandidate: post }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

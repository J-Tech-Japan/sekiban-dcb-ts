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
const INITIAL_CANDIDATE = "9bf654eb555e56a2b0d5ed9f04d0aad670866e9e";
const INITIAL_EVIDENCE_COMMIT = "fc89572e2e0a8b84447591f87be5d05d57396435";
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
  return { ...assertInitialEvidenceCommit(), bridge, sourceCommit: INITIAL_CANDIDATE };
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
    forward?.history?.initialCutover !== "completed-once"
  ) throw new Error("G32 C2 must retain C1/R1 history");
}

export function assertForwardEvidenceShape(forward, manifest) {
  const candidate = forward?.candidateCommit;
  if (candidate !== "CANDIDATE" && !SHA.test(candidate)) throw new Error("G32 C2 candidateCommit is invalid");
  if (forward?.sourceCommit !== candidate) throw new Error("G32 C2 sourceCommit must equal candidateCommit");
  assertForwardProtocol(forward);
  assertDigestShape(forward?.treeDigests, manifest, "G32 C2", candidate === "CANDIDATE");
  if (candidate !== "CANDIDATE") {
    if (
      digestAtCommit(candidate, manifest.runtimeRoots) !== forward.treeDigests.runtime ||
      digestAtCommit(candidate, manifest.configurationRoots) !== forward.treeDigests.configuration ||
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

export function assertPostCandidatePaths(paths, candidate, run = (args) => git(args)) {
  if (candidate === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const unsupported = paths.filter((path) => !R_PATHS.includes(path));
  if (unsupported.length > 0) throw new Error(`G32 post-candidate paths not allowlisted: ${unsupported.join(",")}`);
  if (!same([...paths].sort(), [...R_PATHS].sort())) throw new Error("G32 C2 R must contain exactly evidence and one retained-C append");
  const diff = String(run(["diff", "--unified=0", `${candidate}..HEAD`, "--", ".github/workflows/ci.yml"]));
  const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---"));
  if (removals.length !== 0 || additions.length !== 1 || additions[0].slice(1).trim() !== candidate) {
    throw new Error("G32 C2 retained-candidate list must append exactly C2 once");
  }
  return { checked: true };
}

export function assertPreparedCandidate(candidate, evidence, manifest) {
  assertSha(candidate, "G32 C2 prepared candidate");
  const forward = forwardOf(evidence);
  if (forward.candidateCommit !== "CANDIDATE" || forward.sourceCommit !== "CANDIDATE") {
    throw new Error("G32 prepared C2 must retain its non-self-referential evidence placeholder");
  }
  assertForwardEvidenceShape(forward, manifest);
  const material = assertCandidateMaterialCoverage(candidate, manifest);
  const runtime = digestAtCommit(candidate, manifest.runtimeRoots);
  const configuration = digestAtCommit(candidate, manifest.configurationRoots);
  const deployment = deploymentConfigDigest(candidate);
  if (deployment !== evidence.deploymentConfig.digest) throw new Error("G32 C2 deployment digest changed; this is not the ruled CI/test-only forward fix");
  return { candidate, material, runtime, configuration, deploymentConfig: deployment, runtimeUnchangedFromC1: runtime === evidence.treeDigests.runtime };
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
    history: { initialCandidate: INITIAL_CANDIDATE, initialEvidenceCommit: INITIAL_EVIDENCE_COMMIT, initialCutover: "completed-once" },
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
  assertPostCandidatePaths([...R_PATHS], candidate, () => `+${candidate}\n`);
  let postPathRed = false;
  try { assertPostCandidatePaths([...R_PATHS, "scripts/deploy/g32-forward-redeploy.sh"], candidate, () => `+${candidate}\n`); } catch (error) { postPathRed = String(error).includes("not allowlisted"); }
  if (!postPathRed) throw new Error("G32 post-C operational edit mutation unexpectedly passed");
  return { declaredRoots: manifest.runtimeRoots.length + manifest.configurationRoots.length, requiredRoots: manifest.requiredRoots.length, mutations: ["missing-root", "self-authorized-post-c", "undeclared-material", "repeat-cutover", "data-preservation", "30-digit-ingress", "post-c-operational-edit"] };
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
  const forward = assertForwardEvidenceShape(forwardOf(evidence), manifest);
  const deployment = assertForwardDeploymentIdentity(evidence, cutover);
  const declared = assertDeclaredRoots(manifest);
  const required = assertRequiredRoots(manifest);
  const candidateArgument = argument("--candidate");
  if (candidateArgument !== undefined) {
    if (gitText(["rev-parse", "HEAD"]).trim() !== candidateArgument) throw new Error("G32 prepared candidate must equal checked-out HEAD");
    console.log(JSON.stringify({ history, forward, deployment, manifest: { ...declared, ...required }, prepared: assertPreparedCandidate(candidateArgument, evidence, manifest) }, null, 2));
    return;
  }
  const candidate = forward.candidateCommit;
  const active = candidate !== "CANDIDATE" && SHA.test(candidate) && (() => {
    try { git(["merge-base", "--is-ancestor", candidate, "HEAD"]); return true; } catch { return false; }
  })();
  const post = active
    ? assertPostCandidatePaths(gitText(["diff", "--name-only", `${candidate}..HEAD`]).split(/\r?\n/).filter(Boolean), candidate)
    : { checked: false, reason: candidate === "CANDIDATE" ? "placeholder-candidate" : "candidate-not-ancestor" };
  console.log(JSON.stringify({ history, forward, deployment, manifest: { ...declared, ...required }, postCandidate: post }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

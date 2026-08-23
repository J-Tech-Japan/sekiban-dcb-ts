#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { auditG32LegacyIngress } from "../g32-legacy-ingress-audit.mjs";
import { digestAtCommit as deploymentConfigDigest, G32_DEPLOYMENT_CONFIG_PATHS } from "./g32-config-digest.mjs";
import { assertForwardWitness } from "./g32-forward-witness.mjs";

const root = process.cwd();
const SHA = /^[0-9a-f]{40}$/;
const DIGEST_ALGORITHM = "sha256(path NUL content NUL, paths sorted)";
const PLACEHOLDER = "CANDIDATE";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function recordKey(value, name) {
  const key = required(name, value);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`${name} is not a safe evidence record key`);
  return key;
}

function fullSha(value, name) {
  const candidate = required(name, value);
  if (!SHA.test(candidate)) throw new Error(`${name} must be a full candidate SHA`);
  return candidate;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digestAtTree(treeish, roots) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", treeish, "--", ...roots], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G32 forward evidence digest resolved no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(execFileSync("git", ["show", `${treeish}:${path}`], { cwd: root })); hash.update("\0");
  }
  return hash.digest("hex");
}

function objectAt(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing`);
  return value;
}

function requireFixedMeasurement(measurement, samples) {
  const latency = objectAt(measurement?.latency, "G32 forward measurement latency");
  if (latency.sampleCount !== samples || latency?.samples?.length !== samples || latency.errorCount !== 0) {
    throw new Error(`G32 forward evidence requires exactly fixed N=${samples} clean raw measurements`);
  }
  const stale = latency.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch") {
    throw new Error("G32 forward evidence lacks the old 37-character SUID ingress rejection");
  }
  if (latency?.rawV1?.status !== 404 || latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)) {
    throw new Error("G32 forward evidence has incomplete V1/five-endpoint conformance");
  }
  return latency;
}

function requireTopology(topology, retained) {
  if (topology?.primaryExclusive !== true || topology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 forward evidence does not prove primary-exclusive Queue topology");
  }
  for (const field of ["queue", "primary", "receiver"]) {
    const expected = field === "primary" ? retained.worker : field === "receiver" ? retained.receiver : retained.queue;
    if (topology?.[field] !== expected) throw new Error(`G32 Queue topology changed ${field}`);
  }
  return topology;
}

function requireRecordPlan(record, key, priorKey, label) {
  if (record?.candidateCommit !== PLACEHOLDER || record?.sourceCommit !== PLACEHOLDER) {
    throw new Error(`G32 ${key} must remain a non-self-referential candidate placeholder before recording`);
  }
  const plan = objectAt(record?.recording, `G32 ${key} recording plan`);
  if (
    plan.recordKey !== key || plan.priorRecordKey !== priorKey || plan.candidateLabel !== label ||
    plan.candidateInput !== "--source-commit" || plan.candidateIndependent !== true
  ) throw new Error(`G32 ${key} recording plan does not bind the supplied candidate input`);
  const relation = objectAt(plan.digestRelation, `G32 ${key} digest relation`);
  for (const part of ["runtime", "configuration", "deploymentConfig"]) {
    if (!["unchanged", "changed", "either"].includes(relation[part])) {
      throw new Error(`G32 ${key} digest relation ${part} is invalid`);
    }
  }
  return plan;
}

function assertRelation(part, expected, candidate, prior, key) {
  if (expected === "either") return;
  const same = candidate === prior;
  if ((expected === "unchanged" && !same) || (expected === "changed" && same)) {
    throw new Error(`G32 ${key} ${part} digest relation must be ${expected}`);
  }
}

function requireExtension(post, latency) {
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + 20 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + 20
  ) throw new Error("G32 fixed-N did not extend the preserved store by its 20 logical event operations");
}

function dryRunPost(post, sourceCommit) {
  const clone = structuredClone(post);
  clone.sourceCommit = sourceCommit;
  if (clone.primary) clone.primary.sourceCommit = sourceCommit;
  if (clone.receiver) clone.receiver.sourceCommit = sourceCommit;
  return clone;
}

/**
 * The supplied candidate is the sole identity authority for an evidence run.
 * The injectable resolver is deliberately only an oracle seam: any attempt to
 * substitute a candidate-specific constant is rejected before evidence work.
 */
export function bindCandidateIdentity(sourceCommit, resolveCandidate = (candidate) => candidate) {
  const supplied = fullSha(sourceCommit, "--source-commit");
  const resolved = fullSha(resolveCandidate(supplied), "G32 recorder resolved candidate");
  if (resolved !== supplied) throw new Error("G32 recorder candidate-specific substitution is forbidden");
  return supplied;
}

/** Reject source-level SHA/generation dispatch in addition to the runtime seam. */
export function assertCandidateIndependentRecorderSource(source) {
  if (/\b[0-9a-f]{40}\b/.test(source)) throw new Error("G32 recorder contains a candidate-specific SHA literal");
  const generationRecord = new RegExp(`\\bforwardRedeploy${"C"}\\d+\\b`);
  const generationFlag = `--${"cycle"}`;
  if (generationRecord.test(source) || source.includes(generationFlag)) {
    throw new Error("G32 recorder contains a generation-specific dispatch");
  }
  return { candidateLiterals: 0, generationDispatches: 0 };
}

/** A synthetic-candidate oracle with an exact candidate-hard-code mutation. */
export function runCandidateIndependenceSelfTest(source = readFileSync(new URL(import.meta.url), "utf8")) {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  if (bindCandidateIdentity(first) !== first || bindCandidateIdentity(second) !== second) {
    throw new Error("G32 recorder did not retain arbitrary supplied candidates");
  }
  let hardCodeRed = false;
  try { bindCandidateIdentity(first, () => second); } catch (error) { hardCodeRed = String(error).includes("candidate-specific substitution"); }
  if (!hardCodeRed) throw new Error("G32 recorder candidate-specific hard-code mutation unexpectedly passed");
  const sourceShape = assertCandidateIndependentRecorderSource(source);
  let sourceLiteralRed = false;
  try { assertCandidateIndependentRecorderSource(`${source}\nconst candidate = "${first}";`); } catch (error) { sourceLiteralRed = String(error).includes("candidate-specific SHA literal"); }
  if (!sourceLiteralRed) throw new Error("G32 recorder source candidate-literal mutation unexpectedly passed");
  return { syntheticCandidates: [first, second], hardCodeRed, sourceLiteralRed, ...sourceShape };
}

/**
 * Records any prepared forward witness. Generation labels and prior record
 * keys are data supplied by the sealed placeholder and command line, never
 * recorder branches or candidate constants.
 */
export function buildForwardEvidence({
  sourceCommit,
  treeish = sourceCommit,
  prior,
  manifest,
  pre,
  post,
  measurement,
  topology,
  recordKey: key,
  priorKey,
  candidateLabel,
  preSealChecklist,
  dryRun = false,
  resolveCandidate,
}) {
  const candidate = bindCandidateIdentity(sourceCommit, resolveCandidate);
  const outputKey = recordKey(key, "--record-key");
  const retainedKey = recordKey(priorKey, "--prior-key");
  const label = required("--candidate-label", candidateLabel);
  const draft = objectAt(prior?.[outputKey], `G32 ${outputKey} draft`);
  const retained = objectAt(prior?.[retainedKey], `G32 ${retainedKey} retained evidence`);
  if (!SHA.test(retained?.candidateCommit) || retained.sourceCommit !== retained.candidateCommit) {
    throw new Error(`G32 ${retainedKey} must be completed evidence before a forward recorder can retain it`);
  }
  const plan = requireRecordPlan(draft, outputKey, retainedKey, label);
  const observedPost = dryRun ? dryRunPost(post, candidate) : post;
  const preservation = assertForwardWitness(pre, observedPost, candidate);
  const latency = requireFixedMeasurement(measurement, 10);
  requireExtension(observedPost, latency);
  const queueTopology = requireTopology(topology, objectAt(retained.remoteDeployment, `G32 ${retainedKey} remote deployment`));
  const runtime = digestAtTree(treeish, manifest.runtimeRoots);
  const configuration = digestAtTree(treeish, manifest.configurationRoots);
  const deploymentDigest = deploymentConfigDigest(treeish);
  assertRelation("runtime", plan.digestRelation.runtime, runtime, retained.treeDigests?.runtime, outputKey);
  assertRelation("configuration", plan.digestRelation.configuration, configuration, retained.treeDigests?.configuration, outputKey);
  assertRelation("deploymentConfig", plan.digestRelation.deploymentConfig, deploymentDigest, retained.deploymentConfig?.digest, outputKey);
  const audit = auditG32LegacyIngress();
  const remote = {
    ...retained.remoteDeployment,
    status: `completed ${label} forward-only redeploy on retained G32 bindings`,
    sourceCommit: candidate,
    deployedRuntimeCommit: observedPost.primary?.sourceCommit,
    configDigest: deploymentDigest,
    cutoverFenceFingerprint: observedPost.primary?.cutoverFenceFingerprint,
  };
  const complete = {
    ...draft,
    status: plan.completionStatus ?? `forward witness complete for ${label}`,
    candidateCommit: candidate,
    sourceCommit: candidate,
    treeDigests: {
      ...draft.treeDigests,
      algorithm: DIGEST_ALGORITHM,
      runtime,
      configuration,
    },
    deploymentConfig: {
      ...draft.deploymentConfig,
      algorithm: DIGEST_ALGORITHM,
      digest: deploymentDigest,
      paths: G32_DEPLOYMENT_CONFIG_PATHS,
    },
    runtimeDigestComparison: {
      priorRecordKey: retainedKey,
      relation: plan.digestRelation,
      priorRuntimeDigest: retained.treeDigests?.runtime,
      candidateRuntimeDigest: runtime,
      priorConfigurationDigest: retained.treeDigests?.configuration,
      candidateConfigurationDigest: configuration,
      priorDeploymentConfigDigest: retained.deploymentConfig?.digest,
      candidateDeploymentConfigDigest: deploymentDigest,
      runtimeUnchanged: runtime === retained.treeDigests?.runtime,
      configurationUnchanged: configuration === retained.treeDigests?.configuration,
      deploymentConfigUnchanged: deploymentDigest === retained.deploymentConfig?.digest,
    },
    candidateImpact: {
      ...draft.candidateImpact,
      candidateCommit: candidate,
    },
    remoteDeployment: remote,
    preWitness: pre,
    postWitness: observedPost,
    dataPreservation: {
      status: "preserved-existing-g32-data",
      ...preservation,
      countDeltaCause: {
        preToPost: "The forward deploy script performs no application command before post-witness. Count deltas are recorded but are not the preservation equality condition.",
        preToPostScriptWrites: [],
        fixedNProbeWrites: latency.samples.map((sample) => ({ index: sample.index, roomId: sample.roomId, reservationId: sample.reservationId, suid: sample.commitSuid })),
        fixedNPhase: "runs only after post-witness; it is the deliberate 10-cycle conformance write phase",
      },
    },
    queueTopology,
    fixedNMeasurement: measurement,
    legacyIngressAudit: audit,
    tokenRotation: {
      conformance: `rotated inside the ${label} primary forward deployment using a file-fed secrets file; value redacted`,
      oldToken: "intentionally invalidated; value redacted",
      localFilesAfterMeasurement: "deleted by deploy-script trap",
      dataD1DurableObjectPolicy: "token rotation and forward worker deploy do not mutate application data, D1 rows, or Durable Object storage before the explicit N=10 probes",
    },
    ingressRecheck: {
      positiveG22Cosmos: "30-digit SUID + UUIDv7 + EventType=eventPayloadName + fixed internal g32 provenance",
      retainedNegative: audit.legacyNegative,
      deployedConfig: {
        primaryDigits: observedPost.primary?.sortableUniqueId?.digits,
        receiverDigits: observedPost.receiver?.sortableUniqueId?.digits,
        legacyUnsupported: observedPost.primary?.sortableUniqueId?.legacyUnsupported && observedPost.receiver?.sortableUniqueId?.legacyUnsupported,
        eventTypeAuthority: observedPost.primary?.eventRecord?.eventType,
        oldSuidListStatus: latency.staleNegatives.find((entry) => entry.id === "old-37-character-suid-list")?.status,
      },
    },
    preSealChecklist: preSealChecklist ?? draft.preSealChecklist,
    recorder: {
      ...(draft.recorder ?? {}),
      candidateIndependent: true,
      sourceCommitInput: candidate,
      digestTreeish: treeish,
      dryRun,
      selfTest: "runCandidateIndependenceSelfTest",
    },
  };
  return { ...prior, [outputKey]: complete };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sourceCommit = fullSha(argument("--source-commit", process.env.G32_SOURCE_COMMIT), "--source-commit");
  const treeish = required("--treeish", argument("--treeish", sourceCommit));
  const output = argument("--output", "docs/SDT-G32-cutover-evidence.json");
  if (dryRun && output === "docs/SDT-G32-cutover-evidence.json") {
    throw new Error("G32 recorder dry-run must write a non-evidence preview path");
  }
  const key = recordKey(argument("--record-key"), "--record-key");
  const priorKey = recordKey(argument("--prior-key"), "--prior-key");
  const candidateLabel = required("--candidate-label", argument("--candidate-label"));
  const preSealPath = argument("--preseal");
  const artifacts = {
    sourceCommit,
    treeish,
    prior: readJson("docs/SDT-G32-cutover-evidence.json"),
    manifest: readJson("docs/SDT-G32-required-roots.json"),
    pre: readJson(required("--pre", argument("--pre"))),
    post: readJson(required("--post", argument("--post"))),
    measurement: readJson(required("--measurement", argument("--measurement"))),
    topology: readJson(required("--queue-topology", argument("--queue-topology"))),
    recordKey: key,
    priorKey,
    candidateLabel,
    preSealChecklist: preSealPath === undefined ? undefined : readJson(preSealPath),
    dryRun,
  };
  const evidence = buildForwardEvidence(artifacts);
  const recorded = evidence[key];
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    dryRun,
    recordKey: key,
    candidateCommit: sourceCommit,
    deployedRuntimeCommit: recorded.remoteDeployment.deployedRuntimeCommit,
    runtimeDigest: recorded.treeDigests.runtime,
    configurationDigest: recorded.treeDigests.configuration,
    deploymentConfigDigest: recorded.deploymentConfig.digest,
    samples: recorded.fixedNMeasurement.latency.sampleCount,
  }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();

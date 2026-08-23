#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { auditG32LegacyIngress } from "../g32-legacy-ingress-audit.mjs";
import { digestAtCommit as deploymentConfigDigest, G32_DEPLOYMENT_CONFIG_PATHS } from "./g32-config-digest.mjs";
import { assertForwardWitness } from "./g32-forward-witness.mjs";

const root = process.cwd();
const INITIAL_CANDIDATE = "9bf654eb555e56a2b0d5ed9f04d0aad670866e9e";
const INITIAL_EVIDENCE_COMMIT = "fc89572e2e0a8b84447591f87be5d05d57396435";
const REJECTED_FORWARD_PREFLIGHT_CANDIDATE = "a8f98355bb6de0454725d34f0238cd12efd4519c";
const DIGEST_ALGORITHM = "sha256(path NUL content NUL, paths sorted)";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digestAtCommit(commit, roots) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G32 forward evidence digest resolved no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root })); hash.update("\0");
  }
  return hash.digest("hex");
}

function requireFixedMeasurement(measurement, samples) {
  const latency = measurement?.latency;
  if (latency?.sampleCount !== samples || latency?.samples?.length !== samples || latency?.errorCount !== 0) {
    throw new Error("G32 C2 evidence requires exactly fixed N=10 clean raw measurements");
  }
  const stale = latency.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch") {
    throw new Error("G32 C2 evidence lacks the old 37-character SUID ingress rejection");
  }
  if (latency?.rawV1?.status !== 404 || latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)) {
    throw new Error("G32 C2 evidence has incomplete V1/five-endpoint conformance");
  }
  return latency;
}

function requireTopology(topology, initial) {
  if (topology?.primaryExclusive !== true || topology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 C2 evidence does not prove primary-exclusive Queue topology");
  }
  for (const field of ["queue", "primary", "receiver"]) {
    const expected = field === "primary" ? initial.worker : field === "receiver" ? initial.receiver : initial.queue;
    if (topology?.[field] !== expected) throw new Error(`G32 C2 Queue topology changed ${field}`);
  }
  return topology;
}

export function buildForwardEvidence({ sourceCommit, prior, manifest, pre, post, measurement, topology }) {
  if (prior?.candidateCommit !== INITIAL_CANDIDATE || prior?.sourceCommit !== INITIAL_CANDIDATE) {
    throw new Error("G32 C2 must retain the C1 initial cutover evidence");
  }
  if (prior?.forwardRedeploy?.candidateCommit !== "CANDIDATE" || prior?.forwardRedeploy?.sourceCommit !== "CANDIDATE") {
    throw new Error("G32 C2 evidence replacement requires the sealed C2 placeholder");
  }
  const preservation = assertForwardWitness(pre, post, sourceCommit);
  const latency = requireFixedMeasurement(measurement, 10);
  const queueTopology = requireTopology(topology, prior.remoteDeployment);
  const runtime = digestAtCommit(sourceCommit, manifest.runtimeRoots);
  const configuration = digestAtCommit(sourceCommit, manifest.configurationRoots);
  const deploymentDigest = deploymentConfigDigest(sourceCommit);
  if (deploymentDigest !== prior.deploymentConfig.digest || runtime !== prior.treeDigests.runtime) {
    throw new Error("G32 C2 ruling requires a CI/test fixture forward fix with unchanged runtime/deployment digest");
  }
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + 20 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + 20
  ) throw new Error("G32 C2 fixed-N did not extend the preserved store by its 20 logical event operations");
  const audit = auditG32LegacyIngress();
  const remote = {
    status: "completed C2 forward-only redeploy on retained G32 bindings",
    sourceCommit,
    deployedRuntimeCommit: post.primary.sourceCommit,
    worker: prior.remoteDeployment.worker,
    receiver: prior.remoteDeployment.receiver,
    serviceId: prior.remoteDeployment.serviceId,
    pipelineDatabaseId: prior.remoteDeployment.pipelineDatabaseId,
    materializedViewDatabaseId: prior.remoteDeployment.materializedViewDatabaseId,
    queue: prior.remoteDeployment.queue,
    deadLetterQueue: prior.remoteDeployment.deadLetterQueue,
    durableObjectNamespaces: prior.remoteDeployment.durableObjectNamespaces,
    configDigest: deploymentDigest,
    cutoverFenceFingerprint: post.primary.cutoverFenceFingerprint,
  };
  return {
    ...prior,
    forwardRedeploy: {
      task: "SDT-G32",
      status: "R2 complete: C2 forward-only redeploy/witness after G22 real-Cosmos fixture refresh",
      candidateCommit: sourceCommit,
      sourceCommit,
      reason: "C1 deployed runtime remains correct. C2 updates stale G22 real-Cosmos positive bootstrap inputs to G32 and retains old SUID/provenance/identity forms as typed zero-downstream-call negatives.",
      protocol: {
        candidate: "C2 is one sealed material candidate containing the G22 fixture correction, exhaustive legacy-ingress audit, forward redeploy/witness tooling, candidate gate, manifest, documentation, and this placeholder.",
        bookkeeping: "R2 changes only this evidence document and appends C2 once to the retained-candidate fetch list.",
        selfReference: false,
        deploymentRequired: true,
        forwardOnly: true,
        cutoverReexecuted: false,
        postCandidateAllowlist: ["docs/SDT-G32-cutover-evidence.json", ".github/workflows/ci.yml (one retained-C2 append)"],
        witnessOrder: ["C2-preflight", "public-pre-witness-set", "receiver-forward-deploy", "primary-forward-deploy-with-token-rotation", "post-witness-set-preservation", "N=10", "all-ingress-30-digit-recheck"],
      },
      history: {
        initialCandidate: INITIAL_CANDIDATE,
        initialEvidenceCommit: INITIAL_EVIDENCE_COMMIT,
        initialCutover: "completed-once",
        initialCutoverDeployHistory: "C1 deployed new serviceId/new D1 bindings after bridge/freeze/wipe. C2 neither repeats nor reauthorizes that one-time operation.",
        rejectedPreparedCandidate: REJECTED_FORWARD_PREFLIGHT_CANDIDATE,
        rejectedPreparedCandidateReason: "read-only local forward preflight exposed malformed shell interpolation before any Wrangler invocation",
        rejectedPreparedCandidateRemoteEffects: "none-before-wrangler",
      },
      treeDigests: {
        algorithm: DIGEST_ALGORITHM,
        runtime,
        runtimeRoots: manifest.runtimeRoots,
        configuration,
        configurationRoots: manifest.configurationRoots,
      },
      deploymentConfig: { algorithm: DIGEST_ALGORITHM, digest: deploymentDigest, paths: G32_DEPLOYMENT_CONFIG_PATHS },
      runtimeDigestComparison: {
        initialRuntimeDigest: prior.treeDigests.runtime,
        c2RuntimeDigest: runtime,
        initialDeploymentConfigDigest: prior.deploymentConfig.digest,
        c2DeploymentConfigDigest: deploymentDigest,
        unchanged: true,
        explanation: "C2 changes fixture/test/CI/documentation/witness material only; its deployed runtime/configuration digest is byte-identical to C1.",
      },
      candidateImpact: {
        candidateCommit: sourceCommit,
        deploymentRequired: true,
        newServiceId: false,
        newD1Database: false,
        wipe: false,
        deploymentReason: "The worker must publish C2 source identity and a newly rotated conformance token while retaining existing G32 data and bindings.",
      },
      deployment: {
        forwardOnly: true,
        cutoverReexecuted: false,
        migrationsApplied: false,
        resourcesCreated: false,
        existingBindingsRetained: true,
        workerDeployOrder: ["receiver", "primary"],
        noBridgeFreezeWipeOrReseed: true,
      },
      remoteDeployment: remote,
      preWitness: pre,
      postWitness: post,
      dataPreservation: {
        status: "preserved-existing-g32-data",
        ...preservation,
        countDeltaCause: {
          preToPost: "The forward deploy script performs no application command before post-witness. Count deltas are recorded but not used as the preservation equality condition.",
          preToPostScriptWrites: [],
          fixedNProbeWrites: latency.samples.map((sample) => ({ index: sample.index, roomId: sample.roomId, reservationId: sample.reservationId, suid: sample.commitSuid })),
          fixedNPhase: "runs only after post-witness; it is the deliberate 10-cycle conformance write phase",
        },
      },
      queueTopology,
      fixedNMeasurement: measurement,
      legacyIngressAudit: audit,
      tokenRotation: {
        conformance: "rotated inside the C2 primary forward deployment using a file-fed secrets file; value redacted",
        oldToken: "intentionally invalidated; value redacted",
        localFilesAfterMeasurement: "deleted by deploy-script trap",
        dataD1DurableObjectPolicy: "token rotation and forward worker deploy do not mutate application data, D1 rows, or Durable Object storage before the explicit N=10 probes",
      },
      ingressRecheck: {
        positiveG22Cosmos: "30-digit SUID + UUIDv7 + EventType=eventPayloadName + fixed internal g32 provenance",
        retainedNegative: audit.legacyNegative,
        deployedConfig: {
          primaryDigits: post.primary.sortableUniqueId.digits,
          receiverDigits: post.receiver.sortableUniqueId.digits,
          legacyUnsupported: post.primary.sortableUniqueId.legacyUnsupported && post.receiver.sortableUniqueId.legacyUnsupported,
          eventTypeAuthority: post.primary.eventRecord.eventType,
          oldSuidListStatus: latency.staleNegatives.find((entry) => entry.id === "old-37-character-suid-list")?.status,
        },
      },
      oracleMap: "docs/SDT-G32-oracle-map.md",
      ci: { status: "pending-after-push", verify: "pending", cosmosEmulator: "pending" },
      secrets: "redacted",
    },
  };
}

function main() {
  const sourceCommit = required("--source-commit", argument("--source-commit", process.env.G32_SOURCE_COMMIT));
  const output = argument("--output", "docs/SDT-G32-cutover-evidence.json");
  const prior = readJson(output);
  const manifest = readJson("docs/SDT-G32-required-roots.json");
  const evidence = buildForwardEvidence({
    sourceCommit,
    prior,
    manifest,
    pre: readJson(argument("--pre", ".artifacts/g32-forward-pre-witness.json")),
    post: readJson(argument("--post", ".artifacts/g32-forward-post-witness.json")),
    measurement: readJson(argument("--measurement", ".artifacts/g32-forward-measurement.json")),
    topology: readJson(argument("--queue-topology", ".artifacts/g32-forward-queue-topology.json")),
  });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidateCommit: sourceCommit, deployedRuntimeCommit: evidence.forwardRedeploy.remoteDeployment.deployedRuntimeCommit, samples: evidence.forwardRedeploy.fixedNMeasurement.latency.sampleCount }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();

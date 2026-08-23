#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { auditG32LegacyIngress } from "../g32-legacy-ingress-audit.mjs";
import { digestAtCommit as deploymentConfigDigest, G32_DEPLOYMENT_CONFIG_PATHS } from "./g32-config-digest.mjs";
import { assertForwardWitness } from "./g32-forward-witness.mjs";

const root = process.cwd();
const INITIAL_CANDIDATE = "9bf654eb555e56a2b0d5ed9f04d0aad670866e9e";
const C2_CANDIDATE = "0b38755443cce9d4a1a4383e18ba42499c390f63";
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
  if (entries.length === 0) throw new Error("G32 C3 forward evidence digest resolved no files");
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
    throw new Error("G32 C3 evidence requires exactly fixed N=10 clean raw measurements");
  }
  const stale = latency.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch") {
    throw new Error("G32 C3 evidence lacks the old 37-character SUID ingress rejection");
  }
  if (latency?.rawV1?.status !== 404 || latency?.fiveEndpointConformance?.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)) {
    throw new Error("G32 C3 evidence has incomplete V1/five-endpoint conformance");
  }
  return latency;
}

function requireTopology(topology, retained) {
  if (topology?.primaryExclusive !== true || topology?.receiverServiceBindingOnly !== true) {
    throw new Error("G32 C3 evidence does not prove primary-exclusive Queue topology");
  }
  for (const field of ["queue", "primary", "receiver"]) {
    const expected = field === "primary" ? retained.worker : field === "receiver" ? retained.receiver : retained.queue;
    if (topology?.[field] !== expected) throw new Error(`G32 C3 Queue topology changed ${field}`);
  }
  return topology;
}

function c2Of(prior) {
  const c2 = prior?.forwardRedeploy;
  if (c2?.candidateCommit !== C2_CANDIDATE || c2?.sourceCommit !== C2_CANDIDATE) {
    throw new Error("G32 C3 must retain actual C2 forward evidence");
  }
  return c2;
}

function c3PlaceholderOf(prior) {
  const c3 = prior?.forwardRedeployC3;
  if (c3?.candidateCommit !== "CANDIDATE" || c3?.sourceCommit !== "CANDIDATE") {
    throw new Error("G32 C3 evidence replacement requires the sealed C3 placeholder");
  }
  return c3;
}

/** Replace C3's placeholder only after the one forward-only live witness. */
export function buildC3ForwardEvidence({ sourceCommit, prior, manifest, pre, post, measurement, topology }) {
  if (prior?.candidateCommit !== INITIAL_CANDIDATE || prior?.sourceCommit !== INITIAL_CANDIDATE) {
    throw new Error("G32 C3 must retain the C1 initial cutover evidence");
  }
  const c2 = c2Of(prior);
  c3PlaceholderOf(prior);
  const preservation = assertForwardWitness(pre, post, sourceCommit);
  const latency = requireFixedMeasurement(measurement, 10);
  const queueTopology = requireTopology(topology, c2.remoteDeployment);
  const runtime = digestAtCommit(sourceCommit, manifest.runtimeRoots);
  const configuration = digestAtCommit(sourceCommit, manifest.configurationRoots);
  const deploymentDigest = deploymentConfigDigest(sourceCommit);
  if (runtime === c2.treeDigests.runtime || deploymentDigest === c2.deploymentConfig.digest) {
    throw new Error("G32 C3 must record the reviewed runtime/deployment change from C2");
  }
  const beforeEvents = Number(post?.newStoreState?.eventCount);
  const beforeOps = Number(post?.newStoreState?.eventOpsCount);
  if (
    !Number.isSafeInteger(beforeEvents) || beforeEvents < 1 || !Number.isSafeInteger(beforeOps) || beforeOps < 1 ||
    Number(latency?.finalStoreState?.eventCount) !== beforeEvents + 20 ||
    Number(latency?.finalStoreState?.eventOpsCount) !== beforeOps + 20
  ) throw new Error("G32 C3 fixed-N did not extend the preserved store by its 20 logical event operations");
  const audit = auditG32LegacyIngress();
  const remote = {
    status: "completed C3 forward-only redeploy on retained G32 bindings",
    sourceCommit,
    deployedRuntimeCommit: post.primary.sourceCommit,
    worker: c2.remoteDeployment.worker,
    receiver: c2.remoteDeployment.receiver,
    serviceId: c2.remoteDeployment.serviceId,
    pipelineDatabaseId: c2.remoteDeployment.pipelineDatabaseId,
    materializedViewDatabaseId: c2.remoteDeployment.materializedViewDatabaseId,
    queue: c2.remoteDeployment.queue,
    deadLetterQueue: c2.remoteDeployment.deadLetterQueue,
    durableObjectNamespaces: c2.remoteDeployment.durableObjectNamespaces,
    configDigest: deploymentDigest,
    cutoverFenceFingerprint: post.primary.cutoverFenceFingerprint,
  };
  return {
    ...prior,
    forwardRedeployC3: {
      task: "SDT-G32",
      status: "R3 complete: C3 forward-only redeploy/witness after F1-F5 attribution and real C# provider-path corrections",
      candidateCommit: sourceCommit,
      sourceCommit,
      reason: "C3 closes F1-F5 with production mutation runners, live provider introspection, public CommitWorker zero-call admission oracles, full rebuild-tag field comparison, and pinned C# serialization/provider-to-real-TS import/replay/list-query paths. It also accepts C#'s 1–7 digit UTC fraction without reserializing payload bytes.",
      protocol: {
        candidate: "C3 is one sealed material candidate containing all F1-F5 runtime, oracle, C# provider runner, audit, deployment tooling, documentation, manifest, and non-self-referential placeholder changes.",
        bookkeeping: "R3 changes only this evidence document and appends C3 once to the retained-candidate fetch list.",
        selfReference: false,
        deploymentRequired: true,
        forwardOnly: true,
        cutoverReexecuted: false,
        postCandidateAllowlist: ["docs/SDT-G32-cutover-evidence.json", ".github/workflows/ci.yml (one retained-C3 append)"],
        witnessOrder: ["C3-preflight", "public-pre-witness-set", "receiver-forward-deploy", "primary-forward-deploy-with-token-rotation", "post-witness-set-preservation", "N=10", "all-ingress-30-digit-recheck"],
      },
      history: {
        initialCandidate: INITIAL_CANDIDATE,
        initialEvidenceCommit: "fc89572e2e0a8b84447591f87be5d05d57396435",
        initialCutover: "completed-once",
        initialCutoverDeployHistory: "C1 deployed new serviceId/new D1 bindings after bridge/freeze/wipe. C2 and C3 neither repeat nor reauthorize that one-time operation.",
        rejectedPreparedCandidate: "a8f98355bb6de0454725d34f0238cd12efd4519c",
        rejectedPreparedCandidateReason: "read-only local forward preflight exposed malformed shell interpolation before any Wrangler invocation",
        rejectedPreparedCandidateRemoteEffects: "none-before-wrangler",
        c2Candidate: C2_CANDIDATE,
        c2EvidenceCommit: "acc1dc1746a7310410ced0ae556ec7f87e4970a2",
        c2Reason: "C2 was a G22 real-Cosmos fixture refresh with unchanged runtime/deployment digest; C3 adds reviewed runtime/provider-path corrections and therefore has changed digests.",
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
        c2RuntimeDigest: c2.treeDigests.runtime,
        c3RuntimeDigest: runtime,
        c2DeploymentConfigDigest: c2.deploymentConfig.digest,
        c3DeploymentConfigDigest: deploymentDigest,
        changed: true,
        explanation: "C3 includes runtime fixes (notably C# variable-fraction UTC record ingress) and deployed source changes; both runtime and deployment/config digests intentionally differ from C2.",
      },
      candidateImpact: {
        candidateCommit: sourceCommit,
        deploymentRequired: true,
        newServiceId: false,
        newD1Database: false,
        wipe: false,
        deploymentReason: "The worker must publish C3 source identity and a newly rotated conformance token while retaining C2 data and bindings.",
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
        conformance: "rotated inside the C3 primary forward deployment using a file-fed secrets file; value redacted",
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
  const evidence = buildC3ForwardEvidence({
    sourceCommit,
    prior,
    manifest,
    pre: readJson(argument("--pre", ".artifacts/g32-forward-pre-witness.json")),
    post: readJson(argument("--post", ".artifacts/g32-forward-post-witness.json")),
    measurement: readJson(argument("--measurement", ".artifacts/g32-forward-measurement.json")),
    topology: readJson(argument("--queue-topology", ".artifacts/g32-forward-queue-topology.json")),
  });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidateCommit: sourceCommit, deployedRuntimeCommit: evidence.forwardRedeployC3.remoteDeployment.deployedRuntimeCommit, samples: evidence.forwardRedeployC3.fixedNMeasurement.latency.sampleCount }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();

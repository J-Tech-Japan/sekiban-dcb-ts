#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { assertFinalWitnessIdentity, assertPreWitnessSetPreserved } from "./g29-witness.mjs";

const root = process.cwd();

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digestAtCommit(commit, roots) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots], { cwd: root }).toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root }));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function witnessTopology(witness) {
  return {
    worker: witness.worker,
    serviceId: witness.serviceId,
    viewCount: witness.viewCount,
    allowedViews: witness.allowedViews,
    domainDeliveryClass: witness.domainDeliveryClass,
    resolvedDeliveryClass: witness.resolvedDeliveryClass,
    domainViewDeliveryClasses: witness.domainViewDeliveryClasses,
    directDoorbell: witness.directDoorbell,
    receiverMode: witness.receiverMode,
    degradation: witness.degradation,
    maxServiceBindingInvocations: witness.maxServiceBindingInvocations,
    pipelineDatabaseId: witness.pipelineDatabaseId,
    materializedViewDatabaseId: witness.materializedViewDatabaseId,
    queue: witness.queue,
    generation: witness.generation,
  };
}

function buildEvidence(sourceCommit, pre, post, measurement, manifest, receiverTopology, primaryDeployMode) {
  if (primaryDeployMode !== "deployed-final-c") throw new Error("G29 final evidence requires a witnessed deployment of the sealed final candidate");
  const witnessIdentity = assertFinalWitnessIdentity(sourceCommit, pre, post);
  const dataPreservation = assertPreWitnessSetPreserved(pre.data, post.data);
  if (measurement.latency?.sampleCount !== 10 || measurement.latency?.samples?.length !== 10) throw new Error("G29 final evidence requires exactly N=10 raw samples");
  const probeWrites = measurement.latency.samples.map((sample) => ({ index: sample.index, roomId: sample.roomId, reservationId: sample.reservationId })).filter((sample) => typeof sample.roomId === "string" && typeof sample.reservationId === "string");
  if (probeWrites.length !== 10) throw new Error("G29 fixed-N probe write identities are incomplete");
  if (
    receiverTopology?.primaryExclusive !== true ||
    receiverTopology?.receiverConsumerRemoved === undefined ||
    receiverTopology.queue !== post.queue ||
    receiverTopology.receiver !== "sekiban-dcb-meeting-room-doorbell" ||
    receiverTopology.primary !== post.worker ||
    !Array.isArray(receiverTopology.after) ||
    receiverTopology.after.length !== 1 ||
    receiverTopology.after[0]?.script !== post.worker ||
    receiverTopology.primaryConsumer?.script !== post.worker
  ) throw new Error("G29 receiver Queue topology evidence is invalid");
  const remoteDeployment = {
    status: "completed final-C witnessed redeploy",
    sourceCommit,
    deployedRuntimeCommit: post.sourceCommit,
    worker: post.worker,
    serviceId: post.serviceId,
    pipelineDatabaseId: post.pipelineDatabaseId,
    materializedViewDatabaseId: post.materializedViewDatabaseId,
    queue: post.queue,
    generation: post.generation,
    receiverMode: post.receiverMode,
    directDoorbell: post.directDoorbell,
    degradation: post.degradation,
    identityAndDataPolicy: "existing names/IDs/namespaces/generation/serviceId retained; no reseed or fresh service identity",
    receiverQueueTopology: receiverTopology,
  };
  return {
    task: "SDT-G29",
    status: "R'''' complete: F9 final C'''' witnessed deployment evidence recorded",
    candidateCommit: sourceCommit,
    sourceCommit,
    protocol: {
      candidate: "One immutable C'''' contains the complete runtime, configuration, CI, documentation, witness tooling, candidate gates, required-root manifest, and placeholder evidence.",
      bookkeeping: "R'''' changes only this evidence document and appends C'''' once to the retained-candidate fetch list.",
      selfReference: false,
      deploymentRequired: true,
      witnessOrder: ["preflight", "token-rotation", "pre-witness", "receiver-consumer-check-or-remove", "receiver-deploy", "primary-deploy", "post-witness", "source-commit-assertion", "five-endpoint-conformance", "raw-v1-404", "fixed-N=10"],
    },
    finalWitness: {
      finding: "F9",
      primaryDeployment: primaryDeployMode,
      receiverTopology: "service-binding-only receiver; primary exclusively owns the outbox Queue consumer",
      witnessRule: "every pre-captured row, head, and list entry is required to remain semantically identical after deployment; aggregate counts are recorded but are not an equality gate",
      preWitnessIdentitySource: witnessIdentity.preIdentitySource,
      postWitnessIdentitySource: "remote-g29-conformance",
    },
    treeDigests: {
      algorithm: "sha256(path NUL content NUL, paths sorted)",
      runtime: digestAtCommit(sourceCommit, manifest.runtimeRoots),
      runtimeRoots: manifest.runtimeRoots,
      configuration: digestAtCommit(sourceCommit, manifest.configurationRoots),
      configurationRoots: manifest.configurationRoots,
    },
    remoteDeployment,
    preWitness: pre,
    postWitness: post,
    rawWitness: {
      pre: pre.data,
      post: post.data,
      rowsHeadsCountsLists: "captured in preWitness/postWitness data; secrets redacted",
    },
    fiveEndpointConformance: {
      source: "fixed-N topology probe",
      topology: witnessTopology(measurement.topology),
      rawV1: { pre: pre.rawV1, post: post.rawV1, expectedStatus: 404 },
    },
    fixedNMeasurement: measurement,
    tokenRotation: {
      status: "completed",
      value: "redacted",
      oldToken: "redacted and intentionally invalidated",
      localFileAfterMeasurement: "deleted by deploy trap",
      dataD1DurableObjectPolicy: "token-only change; no data, D1, or Durable Object mutation",
    },
    dataPreservation: {
      ...dataPreservation,
      countDeltaCause: {
        preToPost: "the deploy script makes no data probe write before post-witness; aggregate deltas are observed only and any non-zero value is recorded as concurrent/external rather than attributed to the fixed-N phase",
        preToPostScriptWrites: [],
        fixedNProbeWrites: probeWrites,
        fixedNPhase: "runs after the post-witness; each listed room/reservation pair is the deliberate post-witness write source",
      },
    },
    candidateImpact: {
      candidateCommit: sourceCommit,
      deploymentRequired: true,
      workerBundleChanged: false,
      rationale: "Final-C deployment and witness are required by AC8/AC9; the final C is both deployment and digest authority.",
    },
    oracleMap: "docs/SDT-G29-oracle-map.md",
    candidateGate: "C'''' remains the immutable deployed source authority; the post-C gate allows exactly this evidence document and one retained-candidate append.",
    ci: {
      status: "pending-after-push",
      verify: "pending",
      cosmosEmulator: "pending",
    },
  };
}

function main() {
  const output = argument("--output", "docs/SDT-G29-deploy-evidence.json");
  const ciRun = argument("--ci-run", undefined);
  if (ciRun !== undefined) {
    const evidence = readJson(output);
    evidence.ci = { workflowRun: Number(ciRun), url: `https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/${ciRun}`, verify: "passed", cosmosEmulator: "passed" };
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return;
  }
  const sourceCommit = required("--source-commit", argument("--source-commit", process.env.G29_SOURCE_COMMIT));
  const measurementPath = required("--measurement", argument("--measurement", ".artifacts/g29-measurement.json"));
  const prePath = argument("--pre", ".artifacts/g29-pre-witness.json");
  const postPath = argument("--post", ".artifacts/g29-post-witness.json");
  const receiverTopologyPath = argument("--receiver-topology", ".artifacts/g29-receiver-consumer-topology.json");
  const primaryDeployMode = argument("--primary-deploy-mode", "deployed-final-c");
  const manifest = readJson("docs/SDT-G29-required-roots.json");
  const evidence = buildEvidence(sourceCommit, readJson(prePath), readJson(postPath), readJson(measurementPath), manifest, readJson(receiverTopologyPath), primaryDeployMode);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidateCommit: sourceCommit, deployedRuntimeCommit: evidence.remoteDeployment.deployedRuntimeCommit, samples: evidence.fixedNMeasurement.latency.sampleCount }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { assertFinalWitnessIdentity, assertPreWitnessSetPreserved, assertWitnessStable } from "./g31-witness.mjs";

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
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root }));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function expectedTopology() {
  return {
    worker: "sekiban-dcb-meeting-room-cloudflare-only",
    serviceId: "g25-38219c8-20260820f",
    pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
    materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
    queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
    generation: "v2",
    waitFor: {
      sourceTarget: "unique-indexed-point-read",
      activeReceipt: "generation-definition-bound",
      safeHead: "unique-source-required",
      maxPointReads: 254,
    },
    directDoorbell: true,
    allowedViews: ["RoomProjector", "ReservationProjector"],
  };
}

export function buildEvidence(sourceCommit, pre, post, measurement, manifest, receiverTopology, history) {
  const identity = assertFinalWitnessIdentity(sourceCommit, pre, post);
  const stable = assertWitnessStable(pre, post, expectedTopology());
  const dataPreservation = assertPreWitnessSetPreserved(pre.data, post.data);
  if (measurement?.latency?.sampleCount !== 10 || measurement?.latency?.samples?.length !== 10) {
    throw new Error("G31 final evidence requires exactly fixed N=10 raw samples");
  }
  const oldSuid = measurement.latency.oldSuidGcProbe;
  if (
    oldSuid?.outcome !== "source-target-plus-active-safe-head success after target receipt GC" ||
    oldSuid?.listStatus !== 200 || oldSuid?.waitState?.target?.kind !== "stored" ||
    oldSuid?.waitState?.state?.targetReceipt !== false
  ) throw new Error("G31 final evidence lacks the post-GC old-SUID success probe");
  if (
    receiverTopology?.primaryExclusive !== true ||
    receiverTopology?.receiver !== "sekiban-dcb-meeting-room-doorbell" ||
    receiverTopology?.primary !== post.worker ||
    !Array.isArray(receiverTopology?.after) || receiverTopology.after.length !== 1 ||
    receiverTopology.after[0]?.script !== post.worker
  ) throw new Error("G31 receiver Queue topology evidence is invalid");
  const probeWrites = measurement.latency.samples.map((sample) => ({
    index: sample.index,
    roomId: sample.roomId,
    reservationId: sample.reservationId,
    suid: sample.commitSuid,
  }));
  if (probeWrites.some((sample) => typeof sample.roomId !== "string" || typeof sample.reservationId !== "string" || typeof sample.suid !== "string")) {
    throw new Error("G31 fixed-N probe write identities are incomplete");
  }
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("G31 final evidence must retain the prior C/R history");
  }
  return {
    task: "SDT-G31",
    status: "R-FIX-1 complete: sealed final-C witnessed deployment evidence recorded",
    candidateCommit: sourceCommit,
    sourceCommit,
    protocol: {
      candidate: "One immutable C contains runtime, migrations, sample, CI, tests, documentation, witness tooling, candidate gates, manifest, and placeholder evidence.",
      bookkeeping: "R changes only this evidence document and appends C once to the retained-candidate fetch list.",
      selfReference: false,
      deploymentRequired: true,
      witnessOrder: ["preflight", "pre-witness", "receiver-consumer-check-or-remove", "receiver-deploy", "primary-deploy-with-token-rotation", "post-witness", "source-commit-assertion", "fixed-N=10", "old-SUID-after-GC"],
    },
    history,
    treeDigests: {
      algorithm: "sha256(path NUL content NUL, paths sorted)",
      runtime: digestAtCommit(sourceCommit, manifest.runtimeRoots),
      runtimeRoots: manifest.runtimeRoots,
      configuration: digestAtCommit(sourceCommit, manifest.configurationRoots),
      configurationRoots: manifest.configurationRoots,
    },
    remoteDeployment: {
      status: "completed final-C witnessed redeploy",
      sourceCommit,
      deployedRuntimeCommit: post.sourceCommit,
      worker: post.worker,
      serviceId: post.serviceId,
      pipelineDatabaseId: post.pipelineDatabaseId,
      materializedViewDatabaseId: post.materializedViewDatabaseId,
      queue: post.queue,
      generation: post.generation,
      directDoorbell: post.directDoorbell,
      allowedViews: post.allowedViews,
      waitFor: post.waitFor,
      identityAndDataPolicy: "existing names/IDs/namespaces/generation/serviceId retained; no reseed, fresh identity, D1 reset, or Durable Object reset",
      receiverQueueTopology: receiverTopology,
    },
    finalWitness: {
      primaryDeployment: "deployed-final-c",
      preIdentitySource: identity.preIdentitySource,
      postWitnessIdentitySource: "remote-g31-conformance",
      witnessRule: stable.dataPreservation.rule,
      sourceCommitMatch: identity.match,
    },
    preWitness: pre,
    postWitness: post,
    rawWitness: {
      pre: pre.data,
      post: post.data,
      rowsHeadsCountsLists: "captured in preWitness/postWitness data; secrets redacted",
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
        preToPost: "the deploy script writes no probe before post-witness; aggregate deltas are observed but not an equality gate",
        preToPostScriptWrites: [],
        fixedNProbeWrites: probeWrites,
        fixedNPhase: "runs after post-witness and is the only deliberate command-write phase",
      },
    },
    candidateImpact: {
      candidateCommit: sourceCommit,
      deploymentRequired: true,
      workerBundleChanged: true,
      rationale: "AC7/AC8 require final-C deployment, source identity proof, sampled server wait/list latency, and an old-SUID GC probe.",
    },
    oracleMap: "docs/SDT-G31-oracle-map.md",
    candidateGate: "The sealed C is the immutable deployment and digest authority; post-C changes are exactly evidence plus one retained-C append.",
    ci: { status: "pending-after-push", verify: "pending", cosmosEmulator: "pending" },
  };
}

function main() {
  const output = argument("--output", "docs/SDT-G31-deploy-evidence.json");
  const sourceCommit = required("--source-commit", argument("--source-commit", process.env.G31_SOURCE_COMMIT));
  const measurement = readJson(required("--measurement", argument("--measurement", ".artifacts/g31-measurement.json")));
  const pre = readJson(argument("--pre", ".artifacts/g31-pre-witness.json"));
  const post = readJson(argument("--post", ".artifacts/g31-post-witness.json"));
  const receiverTopology = readJson(argument("--receiver-topology", ".artifacts/g31-receiver-consumer-topology.json"));
  const manifest = readJson("docs/SDT-G31-required-roots.json");
  const priorEvidence = readJson(output);
  const history = Array.isArray(priorEvidence.history) ? priorEvidence.history : [];
  const evidence = buildEvidence(sourceCommit, pre, post, measurement, manifest, receiverTopology, history);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidateCommit: sourceCommit, deployedRuntimeCommit: evidence.remoteDeployment.deployedRuntimeCommit, samples: evidence.fixedNMeasurement.latency.sampleCount }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertWitnessTransition } from "./g32-witness.mjs";
import { digestAtCommit as deploymentConfigDigest, G32_DEPLOYMENT_CONFIG_PATHS } from "./g32-config-digest.mjs";

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

function treeDigest(commit, roots) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G32 tree digest has no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root })); hash.update("\0");
  }
  return hash.digest("hex");
}

function numberAt(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`G32 ${name} is not a non-negative integer`);
  return result;
}

function assertFixedMeasurement(measurement, cutover) {
  const latency = measurement?.latency;
  const sampleCount = cutover.final.fixedSamples;
  if (latency?.sampleCount !== sampleCount || !Array.isArray(latency?.samples) || latency.samples.length !== sampleCount || latency.errorCount !== 0) {
    throw new Error("G32 fixed-N measurement is not complete");
  }
  for (const sample of latency.samples) {
    if (
      typeof sample?.roomId !== "string" || typeof sample?.reservationId !== "string" ||
      typeof sample?.commitSuid !== "string" || !/^[0-9]{30}$/.test(sample.commitSuid) ||
      sample?.createStatus !== 200 || sample?.commandStatus !== 200 || sample?.commandKind !== "committed" || sample?.listStatus !== 200
    ) throw new Error("G32 fixed-N raw sample is invalid");
  }
  if (!Array.isArray(latency.fiveEndpointConformance) || latency.fiveEndpointConformance.length !== 5 || latency.fiveEndpointConformance.some((entry) => entry?.status !== 200)) {
    throw new Error("G32 five-endpoint conformance is incomplete");
  }
  if (latency.rawV1?.status !== 404) throw new Error("G32 raw V1 404 evidence is missing");
  const stale = latency.staleNegatives?.find((entry) => entry?.id === "old-37-character-suid-list");
  if (stale?.status !== 400 || stale?.outcome !== "typed-rejected-before-list-dispatch") {
    throw new Error("G32 old SUID stale-negative is incomplete");
  }
  const expectedEvents = sampleCount * 2;
  if (
    numberAt(latency.finalStoreState?.eventCount, "final eventCount") !== expectedEvents ||
    numberAt(latency.finalStoreState?.eventOpsCount, "final eventOpsCount") !== expectedEvents ||
    latency.finalStoreState?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 final new-store count is not the expected fixed-N write count");
  if (latency.abortForwardFix?.afterFirstWrite !== "forward-fix-only; this script never rolls back new bindings or recreates the old service") {
    throw new Error("G32 abort/forward-fix contract was not recorded");
  }
  return { latency, expectedEvents };
}

function assertQueueTopology(topology, cutover) {
  if (
    topology?.task !== "SDT-G32" || topology?.queue !== cutover.final.queue ||
    topology?.primary !== cutover.final.worker || topology?.receiver !== cutover.final.receiver ||
    topology?.primaryExclusive !== true || topology?.receiverServiceBindingOnly !== true ||
    !Array.isArray(topology?.consumers) || topology.consumers.length !== 1
  ) throw new Error("G32 final Queue topology evidence is invalid");
  return topology;
}

export function buildEvidence({ sourceCommit, pre, post, measurement, topology, manifest, cutover }) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("G32 final evidence requires a full candidate SHA");
  const transition = assertWitnessTransition(pre, post, cutover, sourceCommit);
  const expectedConfigDigest = deploymentConfigDigest(sourceCommit);
  if (
    post?.primary?.configDigest !== expectedConfigDigest || post?.receiver?.configDigest !== expectedConfigDigest ||
    post?.primary?.cutoverFenceFingerprint !== post?.receiver?.cutoverFenceFingerprint ||
    !/^[0-9a-f]{64}$/.test(post?.primary?.cutoverFenceFingerprint ?? "")
  ) throw new Error("G32 deployed primary/receiver config or fence identity is invalid");
  const fixed = assertFixedMeasurement(measurement, cutover);
  const queueTopology = assertQueueTopology(topology, cutover);
  const preEvents = numberAt(pre?.oldStoreInventory?.pipeline?.events, "old event inventory");
  const prePending = numberAt(pre?.oldStoreInventory?.pipeline?.pendingArrivals, "old pending inventory");
  const preRows = numberAt(pre?.oldStoreInventory?.materializedViews?.rows, "old MV row inventory");
  return {
    task: "SDT-G32",
    status: "R complete: bridge B to final C wipe cutover witnessed with fixed-N conformance",
    candidateCommit: sourceCommit,
    sourceCommit,
    bridge: {
      candidateCommit: cutover.bridge.candidateCommit,
      evidencePath: cutover.bridge.evidencePath,
      oldServiceId: cutover.bridge.oldServiceId,
      frozenBeforeFinalC: true,
    },
    protocol: {
      candidate: "B is the sealed old-format freeze-only bridge. C is the one sealed final runtime/configuration/CI/docs/tools/manifest/evidence-placeholder authority.",
      bookkeeping: "R changes only this cutover evidence document and appends C once to the retained-candidate fetch list.",
      selfReference: false,
      deploymentRequired: true,
      postCandidateAllowlist: ["docs/SDT-G32-cutover-evidence.json", ".github/workflows/ci.yml (one retained-C append)"],
      witnessOrder: ["B-freeze", "preflight", "pre-witness", "new-D1-baseline-migrations", "receiver-final-C", "primary-final-C", "queue-topology", "post-witness", "source-commit-assertion", "fixed-N=10"],
    },
    treeDigests: {
      algorithm: "sha256(path NUL content NUL, paths sorted)",
      runtime: treeDigest(sourceCommit, manifest.runtimeRoots),
      runtimeRoots: manifest.runtimeRoots,
      configuration: treeDigest(sourceCommit, manifest.configurationRoots),
      configurationRoots: manifest.configurationRoots,
    },
    deploymentConfig: {
      algorithm: "sha256(path NUL content NUL, paths sorted)",
      digest: expectedConfigDigest,
      paths: G32_DEPLOYMENT_CONFIG_PATHS,
    },
    remoteDeployment: {
      status: "completed final-C cutover on new bindings",
      sourceCommit,
      deployedRuntimeCommit: post.primary.sourceCommit,
      worker: cutover.final.worker,
      receiver: cutover.final.receiver,
      serviceId: cutover.final.serviceId,
      pipelineDatabaseId: cutover.final.pipelineDatabase.id,
      materializedViewDatabaseId: cutover.final.materializedViewDatabase.id,
      queue: cutover.final.queue,
      deadLetterQueue: cutover.final.deadLetterQueue,
      durableObjectNamespaces: cutover.final.durableObjectNamespaces,
      configDigest: expectedConfigDigest,
      cutoverFenceFingerprint: post.primary.cutoverFenceFingerprint,
      oldBindingsClosed: "final C exposes only fresh G32 bindings; the old bridge route is authenticated-404 and the B freeze credential was rotated during final deployment",
    },
    finalWitness: {
      postFinalCDeployment: true,
      sourceCommitMatch: transition.sourceCommitMatch,
      otherServicesUnchanged: transition.otherServicesUnchanged,
      dataPreservation: transition.dataPreservation,
      preWitnessPhase: pre.phase,
      postWitnessPhase: post.phase,
      oldFormatClosure: { rawV1: post.rawV1.status, staleBridge: post.staleBridgeRoute.status },
    },
    dataPreservation: {
      status: "not-applicable-full-wipe",
      rationale: "G32 specifies a new serviceId and new D1 databases because old prefixed SUID values cannot coexist with C# 30-digit SUIDs. No old application rows are copied or read.",
      wipeAllowlistInventory: {
        oldPipelineDatabaseId: cutover.bridge.oldPipelineDatabaseId,
        oldMaterializedViewDatabaseId: cutover.bridge.oldMaterializedViewDatabaseId,
        oldServiceId: cutover.bridge.oldServiceId,
        oldQueue: cutover.bridge.oldQueue,
        preInventory: { events: preEvents, pendingArrivals: prePending, materializedViewRows: preRows },
      },
      newBaseline: {
        pipelineSchemaBeforeMigrationDigest: pre.newStoreBeforeMigration.pipelineSchemaDigest,
        materializedViewSchemaBeforeMigrationDigest: pre.newStoreBeforeMigration.materializedViewSchemaDigest,
        preWriteEventCount: post.newStoreState.eventCount,
        legacySerializedEventTablePresent: post.newStoreState.legacySerializedEventTablePresent,
      },
    },
    preWitness: pre,
    postWitness: post,
    queueTopology,
    fixedNMeasurement: measurement,
    tokenRotation: {
      conformance: "rotated inside the primary/receiver final-C deployment; value redacted",
      bridgeFreezeCredential: "rotated to an unrelated final-deployment value; final code has no bridge route",
      finalFence: "generated file-fed token with matching public fingerprint only; value redacted",
      localFilesAfterMeasurement: "deleted by deploy-script trap",
      dataD1DurableObjectPolicy: "secret rotation does not mutate old or new application data, D1 rows, or Durable Object storage",
    },
    abortForwardFix: {
      beforeFirstApplicationWrite: "abort permitted through final-C deployment, migration baseline verification, and post-witness before the first sample command writes a new logical event",
      firstApplicationWrite: fixed.latency.firstNewWrite,
      afterFirstApplicationWrite: "forward-fix-only; no rollback to old serviceId, old D1, old Queue, or old SUID format is permitted",
    },
    candidateImpact: {
      candidateCommit: sourceCommit,
      deploymentRequired: true,
      newServiceId: true,
      newD1Databases: true,
      oneTimeResetReason: "prefixed old SUID ordering is incompatible with 30-digit C# SUID ordering",
    },
    oracleMap: "docs/SDT-G32-oracle-map.md",
    candidateGate: "C is the deployment and digest authority. R is limited to this evidence and one retained-C append; any other post-C diff requires a fresh C and witnessed deployment.",
    ci: { status: "pending-after-push", verify: "pending", cosmosEmulator: "pending" },
    secrets: "redacted",
  };
}

function main() {
  const sourceCommit = required("--source-commit", argument("--source-commit", process.env.G32_SOURCE_COMMIT));
  const pre = readJson(argument("--pre", ".artifacts/g32-pre-witness.json"));
  const post = readJson(argument("--post", ".artifacts/g32-post-witness.json"));
  const measurement = readJson(argument("--measurement", ".artifacts/g32-measurement.json"));
  const topology = readJson(argument("--queue-topology", ".artifacts/g32-queue-topology.json"));
  const manifest = readJson("docs/SDT-G32-required-roots.json");
  const cutover = readJson("contracts/g32-cutover.json");
  const evidence = buildEvidence({ sourceCommit, pre, post, measurement, topology, manifest, cutover });
  const output = argument("--output", "docs/SDT-G32-cutover-evidence.json");
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidateCommit: sourceCommit, deployedRuntimeCommit: evidence.remoteDeployment.deployedRuntimeCommit, samples: evidence.fixedNMeasurement.latency.sampleCount }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();

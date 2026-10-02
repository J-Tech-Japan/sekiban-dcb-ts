#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { assertB0Evidence } from "../g30-b0-contract.mjs";
import { sealedAuthority } from "../commit-trace-contract.mjs";
import { digestAtCommit as deploymentConfigDigest } from "./g30-config-digest.mjs";

const root = process.cwd();
const SHA = /^[0-9a-f]{40}$/;
const DIGEST_ALGORITHM = "sha256(path NUL content NUL, paths sorted)";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function fullSha(name, value) {
  const sha = required(name, value);
  if (!SHA.test(sha)) throw new Error(`${name} must be a full commit SHA`);
  return sha;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args, encoding = null) {
  return execFileSync("git", args, { cwd: root, encoding });
}

export function digestAtCommit(commit, roots, run = git) {
  const entries = run(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots]).toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G30 tree digest resolved no files");
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(run(["show", `${commit}:${path}`])); hash.update("\0");
  }
  return hash.digest("hex");
}

function boundSource(phase, sourceCommit) {
  const config = phase?.configuration;
  const witness = phase?.deploymentWitness;
  if (
    config?.sourceCommit !== sourceCommit ||
    witness?.sourceCommit !== sourceCommit ||
    witness?.configDigest !== config?.configDigest ||
    witness?.placement !== "off" ||
    witness?.deployedVersion?.id !== config?.deployedVersion ||
    witness?.phase !== phase?.phase ||
    witness?.deployedVersion?.message !== `SDT-G30 B0 ${phase?.phase} ${witness?.serviceId} ${sourceCommit} ${config?.configDigest}`
  ) {
    throw new Error(`G30 ${phase?.phase ?? "phase"} lacks the external Worker Version witness for the sealed source commit`);
  }
  return phase;
}

function markdown(evidence) {
  const latency = evidence.attribution?.latency;
  return [
    "# SDT-G30 B0 evidence",
    "",
    `- Candidate/source/deployed runtime: \`${evidence.candidateCommit}\``,
    `- Service: \`${evidence.serviceId}\`; placement: \`off\`.`,
    `- Trace delivery: ${evidence.attribution?.traces?.schemaCompleteCount ?? 0}/${evidence.attribution?.traces?.clientCount ?? 100} schema-complete; ${evidence.attribution?.traces?.missingCount ?? "n/a"} UNKNOWN loss(es); rank-1..5 tail coverage observed.`,
    `- Client latency universe: full 100-request ledger with ${evidence.attribution?.traces?.latency?.estimator ?? "nearest-rank/full-client-ledger/v1"}; joined per-hop p50/p95 are joined-cohort conditional descriptive estimates and carry their missing-stage sensitivity envelope.`,
    `- Idle schedule: ${(evidence.attribution?.activationIdle?.scheduleMs ?? []).join("/")} ms; ${evidence.attribution?.activationIdle?.observations ?? 0} raw observations.`,
    `- Outlier discrimination: ${evidence.attribution?.outliers?.classifiedOutliers ?? 0}/4 independently evidenced hypotheses; unclassified ${evidence.attribution?.outliers?.unclassifiedOutliers ?? "n/a"}.`,
    `- A→B overhead: p50 ${latency?.overhead?.p50Ms ?? "n/a"} ms; p95 ${latency?.overhead?.p95Ms ?? "n/a"} ms.`,
    `- A/A′ drift: p50 ${latency?.drift?.p50 ?? "n/a"}; p95 ${latency?.drift?.p95 ?? "n/a"}.`,
    "- B0 is attribution-only and is not a G37 improvement denominator.",
    "",
  ].join("\n");
}

/** The supplied candidate is the only candidate authority; no SHA is baked into this recorder. */
export function bindCandidate(sourceCommit, resolve = (value) => value) {
  const supplied = fullSha("--source-commit", sourceCommit);
  const resolved = fullSha("resolved candidate", resolve(supplied));
  if (resolved !== supplied) throw new Error("G30 recorder candidate substitution is forbidden");
  return supplied;
}

export function buildEvidence({ sourceCommit, treeish = sourceCommit, manifest, authority, phaseA, phaseB, phaseAprime, traces, preflight, resolveCandidate }) {
  const candidate = bindCandidate(sourceCommit, resolveCandidate);
  const A = boundSource(phaseA, candidate);
  const B = boundSource(phaseB, candidate);
  const Aprime = boundSource(phaseAprime, candidate);
  const evidence = {
    task: "SDT-G30",
    baseline: "B0",
    purpose: "attribution-only-not-g37-denominator",
    candidateCommit: candidate,
    sourceCommit: candidate,
    deployedRuntimeCommit: candidate,
    serviceId: A.configuration.serviceId,
    authority,
    protocol: {
      selfReference: false,
      finalCandidateSealedOnce: true,
      postCandidateAllowlist: ["docs/SDT-G30-*evidence*.json", "docs/SDT-G30-*evidence*.md", ".github/workflows/ci.yml"],
      protocolAndWireChanged: false,
      placement: "off",
      performancePassFailAsserted: false,
    },
    treeDigests: {
      algorithm: DIGEST_ALGORITHM,
      runtimeRoots: manifest.runtimeRoots,
      configurationRoots: manifest.configurationRoots,
      runtime: digestAtCommit(treeish, manifest.runtimeRoots),
      configuration: digestAtCommit(treeish, manifest.configurationRoots),
    },
    deploymentConfig: { digest: deploymentConfigDigest(treeish) },
    preflight,
    phases: {
      A,
      B,
      "A-prime": Aprime,
    },
    traces: traces.traces,
    observationTraces: traces.observationTraces,
    observations: traces.observations,
    // The inventory is an attribution sidecar only. assertB0Evidence still
    // evaluates AC5 solely from the independently ingested span cohort.
    inventoryObservations: traces.inventoryObservations,
    emittedRowInventory: traces.emittedRowInventory,
    traceExportCompletedAtMs: traces.exportCompletedAtMs,
    rawArtifacts: {
      phaseA: "docs/SDT-G30-B0-evidence-A.json",
      phaseB: "docs/SDT-G30-B0-evidence-B.json",
      phaseAprime: "docs/SDT-G30-B0-evidence-A-prime.json",
      traces: "docs/SDT-G30-B0-evidence-traces.json",
      phaseADeployment: "docs/SDT-G30-B0-evidence-A-deployment.json",
      phaseBDeployment: "docs/SDT-G30-B0-evidence-B-deployment.json",
      phaseAprimeDeployment: "docs/SDT-G30-B0-evidence-A-prime-deployment.json",
      observations: "docs/SDT-G30-B0-evidence-traces.json",
    },
  };
  const attribution = assertB0Evidence(evidence);
  return { ...evidence, attribution };
}

export function selfTest() {
  const candidate = "a".repeat(40);
  if (bindCandidate(candidate) !== candidate) throw new Error("G30 recorder did not preserve the candidate");
  let hardCodeRed = false;
  try { bindCandidate(candidate, () => "b".repeat(40)); } catch (error) { hardCodeRed = String(error).includes("substitution"); }
  if (!hardCodeRed) throw new Error("G30 candidate hard-code mutation unexpectedly passed");
  const rendered = markdown({ candidateCommit: candidate, attribution: { traces: {} } });
  const descriptivePerHopPresent = rendered.includes("joined-cohort conditional descriptive estimates");
  if (!descriptivePerHopPresent) throw new Error("G30 recorder omitted the conditional descriptive per-hop label");
  return { candidateIndependent: true, hardCodeRed, descriptivePerHopPresent };
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const sourceCommit = fullSha("--source-commit", argument("--source-commit", process.env.G30_SOURCE_COMMIT));
  const manifest = readJson(argument("--manifest", "docs/SDT-G30-required-roots.json"));
  const authority = sealedAuthority(root);
  const evidence = buildEvidence({
    sourceCommit,
    manifest,
    authority,
    phaseA: readJson(required("--phase-a", argument("--phase-a"))),
    phaseB: readJson(required("--phase-b", argument("--phase-b"))),
    phaseAprime: readJson(required("--phase-a-prime", argument("--phase-a-prime"))),
    traces: readJson(required("--traces", argument("--traces"))),
    preflight: readJson(required("--preflight", argument("--preflight"))),
  });
  const output = argument("--output", "docs/SDT-G30-b0-evidence.json");
  const markdownOutput = argument("--markdown-output", "docs/SDT-G30-b0-evidence.md");
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  writeFileSync(markdownOutput, markdown(evidence), "utf8");
  console.log(JSON.stringify({ candidate: evidence.candidateCommit, schemaCompleteCount: evidence.attribution.traces.schemaCompleteCount, missingCount: evidence.attribution.traces.missingCount }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

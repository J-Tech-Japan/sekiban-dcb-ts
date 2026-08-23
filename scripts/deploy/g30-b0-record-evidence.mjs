#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { assertB0Evidence } from "../g30-b0-contract.mjs";
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
    `- Trace completeness: ${evidence.attribution?.traces?.requestCount ?? 0}/100; export deadline observed.`,
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

export function buildEvidence({ sourceCommit, treeish = sourceCommit, manifest, authority, phaseA, phaseB, phaseAprime, traces, activation, outliers, preflight, resolveCandidate }) {
  const candidate = bindCandidate(sourceCommit, resolveCandidate);
  const A = boundSource(phaseA, candidate);
  const B = boundSource(phaseB, candidate);
  const Aprime = boundSource(phaseAprime, candidate);
  const warmups = activation?.phases;
  if (warmups === null || typeof warmups !== "object") throw new Error("G30 activation proof is missing phases");
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
      A: { ...A, warmup: warmups.A },
      B: { ...B, warmup: warmups.B },
      "A-prime": { ...Aprime, warmup: warmups["A-prime"] },
    },
    traces: traces.traces,
    traceExportCompletedAtMs: traces.exportCompletedAtMs,
    activationIdle: activation,
    outlierDiscrimination: outliers.outlierDiscrimination,
    rawArtifacts: {
      phaseA: "docs/SDT-G30-B0-evidence-A.json",
      phaseB: "docs/SDT-G30-B0-evidence-B.json",
      phaseAprime: "docs/SDT-G30-B0-evidence-A-prime.json",
      traces: "docs/SDT-G30-B0-evidence-traces.json",
      phaseADeployment: "docs/SDT-G30-B0-evidence-A-deployment.json",
      phaseBDeployment: "docs/SDT-G30-B0-evidence-B-deployment.json",
      phaseAprimeDeployment: "docs/SDT-G30-B0-evidence-A-prime-deployment.json",
      activation: "docs/SDT-G30-B0-evidence-activation.json",
      outliers: "docs/SDT-G30-B0-evidence-outliers.json",
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
  return { candidateIndependent: true, hardCodeRed };
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const sourceCommit = fullSha("--source-commit", argument("--source-commit", process.env.G30_SOURCE_COMMIT));
  const manifest = readJson(argument("--manifest", "docs/SDT-G30-required-roots.json"));
  const authority = {
    A: readJson("contracts/host-pin.json").hostCommit,
    S: "0632c3ed01449efc33eb6afcbb06854ee5a9b862",
    P: "794e31b594f70de2ea346f43c9baca48e58a6738",
    bundleDigest: readJson("contracts/commit-trace-bundle.json").bundleDigest,
  };
  const evidence = buildEvidence({
    sourceCommit,
    manifest,
    authority,
    phaseA: readJson(required("--phase-a", argument("--phase-a"))),
    phaseB: readJson(required("--phase-b", argument("--phase-b"))),
    phaseAprime: readJson(required("--phase-a-prime", argument("--phase-a-prime"))),
    traces: readJson(required("--traces", argument("--traces"))),
    activation: readJson(required("--activation", argument("--activation"))),
    outliers: readJson(required("--outliers", argument("--outliers"))),
    preflight: readJson(required("--preflight", argument("--preflight"))),
  });
  const output = argument("--output", "docs/SDT-G30-b0-evidence.json");
  const markdownOutput = argument("--markdown-output", "docs/SDT-G30-b0-evidence.md");
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  writeFileSync(markdownOutput, markdown(evidence), "utf8");
  console.log(JSON.stringify({ candidate: evidence.candidateCommit, traces: evidence.attribution.traces.requestCount }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

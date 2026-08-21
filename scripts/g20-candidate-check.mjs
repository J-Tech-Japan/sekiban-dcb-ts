#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Candidate rules are reusable: G22 adds one rule rather than copying the gate. */
export const candidateEvidenceRules = Object.freeze([
  Object.freeze({
    id: "g20-cloudflare-only",
    evidencePath: "docs/SDT-G20-deployed-evidence.json",
    evidenceGlobs: Object.freeze(["docs/SDT-G20-deployed-evidence.json"]),
  }),
  Object.freeze({
    id: "g22-bootstrap-operator",
    evidencePath: "docs/SDT-G22-deployed-evidence.json",
    evidenceGlobs: Object.freeze(["docs/SDT-G22-*evidence*.json", "docs/SDT-G22-*evidence*.md"]),
  }),
  Object.freeze({
    id: "g25-unsafe-window-composition",
    evidencePath: "docs/SDT-G25-deploy-evidence.json",
    evidenceGlobs: Object.freeze(["docs/SDT-G25-*evidence*.json", "docs/SDT-G25-*evidence*.md"]),
  }),
  Object.freeze({
    id: "g26-direct-doorbell-fanout",
    evidencePath: "docs/SDT-G26-deploy-evidence.json",
    evidenceGlobs: Object.freeze(["docs/SDT-G26-*evidence*.json", "docs/SDT-G26-*evidence*.md"]),
  }),
]);

function matchesGlob(path, glob) {
  const expression = `^${glob.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")}$`;
  return new RegExp(expression).test(path);
}

export function assertEvidenceOnlyPaths(paths, rule) {
  if (!paths.every((path) => rule.evidenceGlobs.some((glob) => matchesGlob(path, glob)))) {
    throw new Error(`${rule.id} candidate protocol violation; post-candidate paths: ${paths.join(", ")}`);
  }
}
function expectMutationToFail(label, callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`${label} mutation unexpectedly passed the candidate protocol check`);
}

/** Validates declared tree digests without ever comparing their evidence to HEAD. */
export function assertRecordedEvidenceSelfDigest(evidence, rule) {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) throw new Error(`${rule.id} evidence must be an object`);
  if (typeof evidence.candidateCommit !== "string" || (evidence.candidateCommit !== "CANDIDATE" && !SHA.test(evidence.candidateCommit))) throw new Error(`${rule.id} evidence candidateCommit must be CANDIDATE or a 40-character commit SHA`);
  if (evidence.candidateCommit !== "CANDIDATE" && evidence.sourceCommit !== evidence.candidateCommit) throw new Error(`${rule.id} evidence sourceCommit must match candidateCommit`);
  const digests = evidence.treeDigests;
  if (typeof digests !== "object" || digests === null || Array.isArray(digests) || digests.algorithm !== "sha256(path NUL content NUL, paths sorted)" || !SHA256.test(digests.runtime) || !SHA256.test(digests.configuration) || !Array.isArray(digests.runtimeRoots) || !Array.isArray(digests.configurationRoots) || ![...digests.runtimeRoots, ...digests.configurationRoots].every((path) => typeof path === "string" && path.length > 0)) throw new Error(`${rule.id} evidence tree digest declaration is invalid`);
}

/**
 * A FINAL candidate records hashes of its candidate tree, not of a later
 * evidence-only commit.  This makes the check self-proving without allowing a
 * source edit to be smuggled in after deployment.
 */
export function assertCandidateTreeDigests(evidence, run = (args) => execFileSync("git", args, { cwd: root, encoding: null })) {
  if (evidence.candidateCommit === "CANDIDATE") return { checked: false, reason: "placeholder-candidate" };
  const digest = (roots) => {
    const entries = run(["ls-tree", "-r", "-z", "--name-only", evidence.candidateCommit, "--", ...roots])
      .toString("utf8").split("\0").filter(Boolean).sort();
    const hash = createHash("sha256");
    for (const path of entries) {
      hash.update(path); hash.update("\0");
      hash.update(run(["show", `${evidence.candidateCommit}:${path}`])); hash.update("\0");
    }
    return hash.digest("hex");
  };
  const runtime = digest(evidence.treeDigests.runtimeRoots);
  const configuration = digest(evidence.treeDigests.configurationRoots);
  if (runtime !== evidence.treeDigests.runtime || configuration !== evidence.treeDigests.configuration) {
    throw new Error("candidate tree digests do not match the declared FINAL candidate");
  }
  return { checked: true, runtime, configuration };
}

function gitSucceeds(args, run) {
  try { run(args); return true; } catch { return false; }
}

/** Candidate-to-HEAD enforcement applies only to a live, ancestor candidate. */
export function candidateGateStatus(candidate, run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  if (candidate === "CANDIDATE") return { active: false, reason: "placeholder-candidate" };
  if (!SHA.test(candidate)) throw new Error("candidateCommit must be a 40-character commit SHA");
  if (!gitSucceeds(["cat-file", "-e", `${candidate}^{commit}`], run)) return { active: false, reason: "candidate-unresolved" };
  if (!gitSucceeds(["merge-base", "--is-ancestor", candidate, "HEAD"], run)) return { active: false, reason: "candidate-not-ancestor" };
  return { active: true, reason: "candidate-ancestor" };
}

function changedPaths(candidate) {
  return execFileSync("git", ["diff", "--name-only", `${candidate}..HEAD`], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

/** Focused active, unresolved, and non-ancestor oracle without fixture repos. */
export function runSelfTest() {
  const candidate = "a".repeat(40);
  const active = candidateGateStatus(candidate, () => "");
  const unresolved = candidateGateStatus(candidate, (args) => { if (args[0] === "cat-file") throw new Error("missing"); return ""; });
  const nonAncestor = candidateGateStatus(candidate, (args) => { if (args[0] === "merge-base") throw new Error("not ancestor"); return ""; });
  if (!active.active || unresolved.active || nonAncestor.active || unresolved.reason !== "candidate-unresolved" || nonAncestor.reason !== "candidate-not-ancestor") throw new Error("candidate gate focused verification failed");
  console.log(JSON.stringify({ active, unresolved, nonAncestor }, null, 2));
}

function main() {
  if (process.env.SDT_G22_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G22 candidate gate forced failure");
  if (process.env.SDT_G25_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G25 candidate gate forced failure");
  if (process.env.SDT_G26_CANDIDATE_FORCE_FAILURE === "1") throw new Error("SDT-G26 candidate gate forced failure");
  if (process.argv.includes("--self-test")) return runSelfTest();
  for (const rule of candidateEvidenceRules) {
    const evidencePath = join(root, rule.evidencePath);
    if (!existsSync(evidencePath)) throw new Error(`${rule.id} deployed evidence document is required`);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    // These proofs and evidence self-consistency stay active even when the
    // live candidate rule is explicitly not applicable after a squash merge.
    expectMutationToFail(`${rule.id}:runtime-path`, () => assertEvidenceOnlyPaths(["packages/dcb-runtime/src/index.ts"], rule));
    assertEvidenceOnlyPaths([rule.evidencePath], rule);
    assertRecordedEvidenceSelfDigest(evidence, rule);
    const treeDigestProof = assertCandidateTreeDigests(evidence);
    const status = candidateGateStatus(evidence.candidateCommit);
    const postCandidatePaths = status.active ? changedPaths(evidence.candidateCommit) : [];
    if (status.active) assertEvidenceOnlyPaths(postCandidatePaths, rule);
    console.log(JSON.stringify({
      rule: rule.id,
      candidateCommit: evidence.candidateCommit,
      protocol: status.active ? "active" : "protocol-not-active",
      reason: status.reason,
      postCandidatePaths,
      mutationProof: { runtimePath: "fail-as-required", evidenceDocument: "accepted" },
      evidenceSelfDigest: "validated-without-head-comparison",
      treeDigestProof,
    }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

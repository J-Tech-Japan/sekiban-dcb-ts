#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const evidencePath = join(root, "docs/SDT-G20-deployed-evidence.json");
if (!existsSync(evidencePath)) throw new Error("G20 deployed evidence document is required");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const candidate = evidence.candidateCommit;
const evidenceDocuments = new Set(["docs/SDT-G20-deployed-evidence.json"]);
function assertEvidenceOnlyPaths(paths) {
  if (!paths.every((path) => evidenceDocuments.has(path))) {
    throw new Error(`G20 candidate protocol violation; post-candidate paths: ${paths.join(", ")}`);
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

// This is intentionally executed on every invocation, including the
// placeholder-candidate run. It prevents the allowlist predicate from being
// replaced with a success-looking no-op without making CI red.
expectMutationToFail("runtime-path", () => assertEvidenceOnlyPaths(["packages/dcb-runtime/src/index.ts"]));
assertEvidenceOnlyPaths(["docs/SDT-G20-deployed-evidence.json"]);
if (candidate === "CANDIDATE") {
  console.log(JSON.stringify({
    candidateCommit: candidate,
    postCandidatePaths: [],
    evidenceOnly: true,
    mutationProof: { runtimePath: "fail-as-required", evidenceDocument: "accepted" },
  }, null, 2));
  process.exit(0);
}
if (typeof candidate !== "string" || !/^[0-9a-f]{40}$/.test(candidate)) {
  throw new Error("G20 evidence candidateCommit must be a 40-character commit SHA");
}
const changed = execFileSync("git", ["diff", "--name-only", `${candidate}..HEAD`], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
assertEvidenceOnlyPaths(changed);
console.log(JSON.stringify({
  candidateCommit: candidate,
  postCandidatePaths: changed,
  evidenceOnly: true,
  mutationProof: { runtimePath: "fail-as-required", evidenceDocument: "accepted" },
}, null, 2));

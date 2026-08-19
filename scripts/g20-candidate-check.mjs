#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const evidencePath = join(root, "docs/SDT-G20-deployed-evidence.json");
if (!existsSync(evidencePath)) throw new Error("G20 deployed evidence document is required");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const candidate = evidence.candidateCommit;
if (candidate === "CANDIDATE") {
  console.log("G20 candidate commit self-check: no post-candidate evidence commits yet");
  process.exit(0);
}
if (typeof candidate !== "string" || !/^[0-9a-f]{40}$/.test(candidate)) {
  throw new Error("G20 evidence candidateCommit must be a 40-character commit SHA");
}
const changed = execFileSync("git", ["diff", "--name-only", `${candidate}..HEAD`], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
const evidenceOnly = changed.length > 0 && changed.every((path) => path.startsWith("docs/") && path.endsWith(".json"));
if (!evidenceOnly) throw new Error(`G20 candidate protocol violation; post-candidate paths: ${changed.join(", ")}`);
console.log(JSON.stringify({ candidateCommit: candidate, postCandidatePaths: changed, evidenceOnly: true }, null, 2));

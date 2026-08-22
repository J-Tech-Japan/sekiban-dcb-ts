#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
export const G32_DEPLOYMENT_CONFIG_PATHS = Object.freeze([
  "contracts/g32-cutover.json",
  "contracts/event-store-ddl.json",
  "migrations/d1/g32",
  "migrations/mv",
  "packages/dcb-runtime/src",
  "samples/meeting-room/src/compatibility.ts",
  "samples/meeting-room/src/d1-mv.ts",
  "samples/meeting-room/src/domain.ts",
  "samples/meeting-room/src/transport.ts",
  "samples/meeting-room/src/worker.cloudflare-only.ts",
  "samples/meeting-room/wrangler.g32-final-primary.jsonc",
  "samples/meeting-room/wrangler.g32-final-receiver.jsonc",
]);

export function digestAtCommit(commit, paths = G32_DEPLOYMENT_CONFIG_PATHS) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...paths], { cwd: ROOT })
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length === 0) throw new Error("G32 deployment config digest has no files");
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry); hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${entry}`], { cwd: ROOT })); hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commit = process.argv[2] ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  console.log(digestAtCommit(commit));
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();

/** Configuration material only; runtime roots are checked independently. */
export const G30_DEPLOYMENT_CONFIG_PATHS = Object.freeze([
  "samples/meeting-room/wrangler.g30-primary-off.jsonc",
  "samples/meeting-room/wrangler.g30-primary-on.jsonc",
  "samples/meeting-room/wrangler.g30-receiver-off.jsonc",
  "samples/meeting-room/src/worker.cloudflare-only.ts",
  "scripts/deploy/g30-b0-deploy.sh",
  "scripts/g30-b0-measure.mjs",
  "scripts/deploy/g30-b0-measure.mjs",
  "scripts/deploy/g30-observability-query.mjs",
  "scripts/deploy/g30-observability-query.json",
  "scripts/deploy/g30-b0-record-evidence.mjs",
  "scripts/g30-trace-export.mjs",
  "scripts/deploy/g30-trace-export.mjs",
  "scripts/g30-b0-contract.mjs",
  "scripts/g30-ac5-structural-check.mjs",
  "scripts/g30-ac5-mutation-runner.mjs",
  "scripts/g30-trace-runtime-verifier.mjs",
]);

function git(args, encoding = null) {
  return execFileSync("git", args, { cwd: root, encoding });
}

export function digestAtCommit(treeish, paths = G30_DEPLOYMENT_CONFIG_PATHS, run = git) {
  const entries = run(["ls-tree", "-r", "-z", "--name-only", treeish, "--", ...paths]).toString("utf8").split("\0").filter(Boolean).sort();
  if (entries.length !== paths.length) throw new Error(`G30 deployment digest expected ${paths.length} paths, found ${entries.length}`);
  const hash = createHash("sha256");
  for (const path of entries) {
    hash.update(path); hash.update("\0");
    hash.update(run(["show", `${treeish}:${path}`])); hash.update("\0");
  }
  return hash.digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const treeish = process.argv[2] ?? "HEAD";
  console.log(digestAtCommit(treeish));
}

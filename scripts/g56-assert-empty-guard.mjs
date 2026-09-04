#!/usr/bin/env node
/**
 * SDT-G56 local contract guard. It keeps the accepted empty-head sentinel
 * visible at the runtime, client, authoring, adapter, and G54 catalogue
 * boundaries without inspecting or invoking any remote resource.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

const checks = Object.freeze([
  ["commit-validator-accepts-empty", "packages/dcb-runtime/src/commit/CommitWorker.ts", 'if (rawTag.lastSortableUniqueId !== "") {'],
  ["tag-parser-accepts-empty", "packages/dcb-runtime/src/tag/TagDurableObject.ts", 'if (rawEntry.lastSortableUniqueId !== "") {'],
  ["tag-assert-empty-conflict", "packages/dcb-runtime/src/tag/TagDurableObject.ts", 'const ASSERT_EMPTY_CONFLICT_REASON = "consistency_head_mismatch_assert_empty";'],
  ["session-normalizes-empty-head", "packages/dcb-domain/src/session.ts", 'const suppliedHead = supplied.head ?? "";'],
  ["session-records-exists-empty", "packages/dcb-domain/src/session.ts", 'if (snapshotExists === false) {'],
  ["client-preserves-empty-claim", "packages/dcb-client/src/index.ts", "An empty tag head is the explicit V1 assert-empty sentinel"],
  ["sample-adapter-preserves-empty-claim", "samples/meeting-room/src/transport.ts", "claim.head !== null"],
  ["g54-acceptance-catalogue", "test/fixtures/g54-accepted-positives.json", '"classification": "accepted-positive"'],
  ["g56-red-oracle", "test/g56-assert-empty.spec.ts", "writes version one, repeats as a typed conflict"],
]);

function fail(message) {
  throw new Error(`SDT-G56 assert-empty guard: ${message}`);
}

function main() {
  for (const [name, relativePath, required] of checks) {
    const source = readFileSync(resolve(root, relativePath), "utf8");
    if (!source.includes(required)) fail(`${name} missing required contract marker`);
  }
  process.stdout.write(`${JSON.stringify({ result: "g56-assert-empty-contract-green", checks: checks.map(([name]) => name), remote: "not-invoked" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

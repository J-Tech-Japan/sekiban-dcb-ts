#!/usr/bin/env node
/**
 * Execute SDT-G46's independent falsifications against the real Miniflare
 * Tag/TagState path.  These are deliberately production mutations, not
 * parallel model assertions: each breaks one AC authority and its named
 * focused fixture must turn red.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const G46_MUTATIONS = Object.freeze([
  {
    fact: "normal_delta_reprojects_from_origin",
    sourceFile: "packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts",
    from: "this.readSource(identity, cache.lastSuid, undefined)",
    to: 'this.readSource(identity, "", undefined)',
    rebuildRuntime: true,
    oracleTitle: "uses the single bounded G43 source adapter for normal deltas",
  },
  {
    fact: "g45_head_facts_bypassed",
    sourceFile: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
    from: "const facts = this.readHeadFacts(input.tag);",
    to: "const facts = undefined as ReturnType<typeof this.readHeadFacts>;",
    rebuildRuntime: true,
    oracleTitle: "measures the real G45 head-facts bounded source seam at every history point",
  },
  {
    fact: "unknown_source_path",
    sourceFile: "packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts",
    from: "/__internal/g46/tag-state-incremental",
    to: "/__internal/g46/unknown-source",
    rebuildRuntime: true,
    oracleTitle: "uses the single bounded G43 source adapter for normal deltas",
  },
  {
    fact: "partial_replay_is_served",
    sourceFile: "packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts",
    from: 'return error(503, "tag_state_rebuild_in_progress", "TagState replay is rebuilding to its frozen frontier");',
    to: "return json(this.success(projector, accumulatorJson, page.lastSortableUniqueId));",
    rebuildRuntime: true,
    oracleTitle: "freezes the first source frontier and advances a normal delta only after that frontier completes",
  },
  {
    fact: "unknown_projector_is_masqueraded",
    sourceFile: "packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts",
    from: 'return error(404, "tag_state_unknown_projector", "TagState projector is not registered");',
    to: 'return error(503, "tag_state_source_frontier_failure", "TagState projector is not registered");',
    rebuildRuntime: true,
    oracleTitle: "reports an unknown projector as a distinct typed non-success",
  },
  {
    fact: "registry_failure_is_masqueraded",
    sourceFile: "packages/dcb-runtime/src/read/SerializedReadWorker.ts",
    from: 'return error(503, "tag_state_projector_registry_failure", "Tag-state projector registry is unavailable");',
    to: 'return error(404, "tag_state_unknown_projector", "Tag-state projector registry is unavailable");',
    rebuildRuntime: true,
    oracleTitle: "reports a projector registry failure as a distinct typed non-success",
  },
  {
    fact: "source_failure_is_masqueraded",
    sourceFile: "packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts",
    from: 'return error(caught.status, "tag_state_source_frontier_failure", "TagState source frontier could not be read");',
    to: 'return error(caught.status, "tag_state_unknown_projector", "TagState source frontier could not be read");',
    rebuildRuntime: true,
    oracleTitle: "reports a source frontier failure as a distinct typed non-success",
  },
  {
    fact: "cache_corruption_is_masqueraded",
    sourceFile: "packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts",
    from: 'return error(409, "tag_state_cache_corrupt", "TagState cache is corrupt and is rebuilding");',
    to: 'return error(409, "tag_state_source_frontier_failure", "TagState cache is corrupt and is rebuilding");',
    rebuildRuntime: true,
    oracleTitle: "reports detected cache corruption as a typed non-success rather than an empty projection",
  },
  {
    fact: "all_points_measurement_becomes_endpoint_only",
    sourceFile: "test/g46-tagstate.spec.ts",
    from: "for (const row of rows) {",
    to: "for (const row of [rows[0]!, rows.at(-1)!]) {",
    oracleTitle: "rejects an intermediate source-row spike even when the endpoint rows are bounded",
  },
]);

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, fact) {
  if (result.status !== 0) return;
  throw new Error(`G46 ${fact} mutation was vacuous: its focused oracle remained green`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G46 ${mutation.fact} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function oracle(title) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g46-tagstate.spec.ts",
    "--testNamePattern", title,
  ], `G46 runtime oracle (${title})`);
}

function buildRuntime() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation.oracleTitle));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    if (mutation.rebuildRuntime === true) requirePass(buildRuntime());
    requireRed(oracle(mutation.oracleTitle), mutation.fact);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    if (mutation.rebuildRuntime === true) requirePass(buildRuntime());
  }
  return { fact: mutation.fact, result: "production-mutant-red" };
}

function selfTest() {
  for (const mutation of G46_MUTATIONS) {
    mutate(readFileSync(resolve(root, mutation.sourceFile), "utf8"), mutation);
  }
  process.stdout.write(`${JSON.stringify({ mutations: G46_MUTATIONS.map(({ fact }) => fact), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(buildRuntime());
  const rows = G46_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g46-tagstate-mutations-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

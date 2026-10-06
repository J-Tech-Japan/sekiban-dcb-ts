#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const checker = "scripts/g30-config-check.mjs";
const configFile = "samples/meeting-room/wrangler.cloudflare-only.jsonc";
const mutations = Object.freeze([
  {
    id: "sampling",
    from: '  "traces": { "enabled": true, "head_sampling_rate": 1, "persist": true }',
    to: '  "traces": { "enabled": true, "head_sampling_rate": 0, "persist": true }',
    diagnostic: "G30 current sample must keep trace sampling 1",
  },
  {
    id: "observation-log-persistence",
    from: '  "logs": { "enabled": true, "persist": true, "invocation_logs": true, "head_sampling_rate": 1 },',
    to: '  "logs": { "enabled": true, "persist": false, "invocation_logs": true, "head_sampling_rate": 1 },',
    diagnostic: "G30 current sample must persist observability logs",
  },
  {
    id: "placement",
    from: '  "compatibility_flags": ["nodejs_compat"],',
    to: '  "compatibility_flags": ["nodejs_compat"],\n  "placement": "smart",',
    diagnostic: "G30 current sample must not enable placement or locationHint",
  },
]);

function run() {
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function mutate(source, mutation) {
  if (source.split(mutation.from).length !== 2) {
    throw new Error(`G30 ${mutation.id} expected one mutation anchor`);
  }
  return source.replace(mutation.from, mutation.to);
}

const path = resolve(root, configFile);
const original = readFileSync(path, "utf8");
const results = [];
try {
  if (run().status !== 0) throw new Error("G30 current configuration baseline unexpectedly failed");
  for (const mutation of mutations) {
    writeFileSync(path, mutate(original, mutation), "utf8");
    const result = run();
    const red = result.status !== 0 && result.output.includes(mutation.diagnostic);
    results.push({ id: mutation.id, seam: "assertG30Config", diagnostic: mutation.diagnostic, result: red ? "red" : "invalid-red" });
    if (!red) throw new Error(`G30 ${mutation.id} did not produce its named checker diagnostic:\n${result.output}`);
    writeFileSync(path, original, "utf8");
  }
} finally {
  writeFileSync(path, original, "utf8");
}
console.log(JSON.stringify({ configFile, mutations: results, result: "all-current-config-mutants-red" }, null, 2));

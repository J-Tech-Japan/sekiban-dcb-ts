#!/usr/bin/env node
/**
 * Three-layer zero-external-database gate for the named G20 variant.
 *
 * The mutation checks below intentionally exercise the gate predicates in
 * memory. They are not a green grep: each representative forbidden change is
 * required to make its layer fail.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const configPath = join(root, "samples/meeting-room/wrangler.cloudflare-only.jsonc");
const buildDir = join(root, ".artifacts/g20-cloudflare-build");
const metaPath = join(buildDir, "bundle-meta.json");
const forbidden = [
  "PostgresEventStore",
  "CosmosRestClient",
  "@sekiban/dcb-runtime/cosmos",
  "HYPERDRIVE",
  "POSTGRES_URL",
  "COSMOS_ENDPOINT",
  "COSMOS_KEY",
  "postgres",
];

function requireGate(condition, message) {
  if (!condition) throw new Error(message);
}

function checkVariantConfig(source) {
  const lowered = source.toLowerCase();
  requireGate(!lowered.includes("hyperdrive"), "cloudflare-only config contains Hyperdrive");
  requireGate(!lowered.includes("postgres"), "cloudflare-only config contains Postgres identifiers");
  requireGate(!lowered.includes("cosmos"), "cloudflare-only config contains Cosmos identifiers");
  requireGate(/"binding"\s*:\s*"D1"/.test(source), "cloudflare-only config lacks D1 pipeline binding");
  requireGate(/"binding"\s*:\s*"D1_MV"/.test(source), "cloudflare-only config lacks D1_MV binding");
  requireGate(/"queues"\s*:/.test(source), "cloudflare-only config lacks Queues");
  requireGate(/"durable_objects"\s*:/.test(source), "cloudflare-only config lacks Durable Objects");
}

function checkMetafile(meta) {
  const serialized = JSON.stringify(meta);
  for (const value of forbidden) {
    requireGate(!serialized.includes(value), `cloudflare-only import graph contains ${value}`);
  }
}

function checkBuiltOutput(output) {
  for (const value of forbidden) {
    requireGate(!output.includes(value), `cloudflare-only built output contains ${value}`);
  }
}

function expectMutationToFail(label, callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  requireGate(failed, `${label} mutation unexpectedly passed the zero-external-DB gate`);
}

function buildVariant() {
  mkdirSync(buildDir, { recursive: true });
  const result = spawnSync(
    join(root, "node_modules/.bin/wrangler"),
    ["deploy", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc", "--dry-run", "--outdir", ".artifacts/g20-cloudflare-build", "--outfile", ".artifacts/g20-cloudflare-build/worker.js", "--metafile", ".artifacts/g20-cloudflare-build/bundle-meta.json"],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`cloudflare-only dry-run failed with exit ${result.status}`);
  }
}

const config = readFileSync(configPath, "utf8");
checkVariantConfig(config);
expectMutationToFail("binding-config", () => checkVariantConfig(`${config}\n  "hyperdrive": [{"binding":"HYPERDRIVE"}]`));

buildVariant();
requireGate(existsSync(metaPath), "cloudflare-only Wrangler dry-run did not emit a bundle metafile");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
checkMetafile(meta);
expectMutationToFail("import-graph", () => checkMetafile({ ...meta, inputs: { ...meta.inputs, "packages/dcb-runtime/src/store/PostgresEventStore.ts": {} } }));

const outputs = readdirSync(buildDir).filter((name) => name.endsWith(".js"));
requireGate(outputs.length > 0, "cloudflare-only Wrangler dry-run emitted no JavaScript worker output");
const built = outputs.map((name) => readFileSync(join(buildDir, name), "utf8")).join("\n");
checkBuiltOutput(built);
expectMutationToFail("built-output", () => checkBuiltOutput(`${built}\nPostgresEventStore`));

console.log(JSON.stringify({
  variant: "samples/meeting-room/wrangler.cloudflare-only.jsonc",
  layers: {
    bindingConfig: "pass",
    importGraphMetafile: "pass",
    builtOutput: "pass",
  },
  mutationProof: {
    bindingConfig: "fail-as-required",
    importGraphMetafile: "fail-as-required",
    builtOutput: "fail-as-required",
  },
  outputFiles: outputs,
}, null, 2));

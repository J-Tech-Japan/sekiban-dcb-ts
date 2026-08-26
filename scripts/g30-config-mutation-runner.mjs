#!/usr/bin/env node
/**
 * G30 phase isolation is a deployment invariant, so exercise the real
 * Worker entrypoint and deploy runbook rather than only a copied string in a
 * unit self-test.  Each mutation is restored even when its oracle fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const checker = "scripts/g30-config-check.mjs";
const authority = "scripts/commit-trace-contract.mjs";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

const MUTATIONS = Object.freeze([
  {
    id: "runtime-witness-protocol-in-worker",
    file: "samples/meeting-room/src/worker.cloudflare-only.ts",
    from: "  readonly G32_FREEZE_RELEASE?: string;",
    to: "  readonly G32_FREEZE_RELEASE?: string;\n  readonly G30_SOURCE_COMMIT?: string;",
  },
  {
    id: "sample-runtime-variable-in-runbook",
    file: "scripts/deploy/g30-b0-deploy.sh",
    from: 'common_vars=(--var "SDT_SERVICE_ID:g32-9043d626fe1149cb")',
    to: 'common_vars=(--var "G30_TRACE_SAMPLE_RATE:1" --var "SDT_SERVICE_ID:g32-9043d626fe1149cb")',
  },
  {
    id: "remote-migration-binding",
    file: "scripts/deploy/g30-b0-deploy.sh",
    from: 'd1 migrations list "${binding}"',
    to: 'd1 migrations list "${database}"',
  },
  {
    id: "remote-migration-preflight-order",
    file: "scripts/deploy/g30-b0-deploy.sh",
    from: 'assert_sealed_d1_config\n  for binding in "${PRIMARY_D1_BINDINGS[@]}"; do',
    to: 'for binding in "${PRIMARY_D1_BINDINGS[@]}"; do\n    assert_sealed_d1_config',
  },
  {
    id: "remote-migration-cwd-relative-config",
    file: "scripts/deploy/g30-b0-deploy.sh",
    from: 'd1 migrations list "${binding}" --config "${PRIMARY_CONFIG_PATH}" --remote',
    to: 'd1 migrations list "${binding}" --cwd samples/meeting-room --config "wrangler.g30-primary-off.jsonc" --remote',
  },
  {
    id: "remote-migration-id-verification",
    file: "scripts/g30-config-check.mjs",
    from: 'if (entry?.database_id !== expected.id || entry?.database_name !== expected.name || entry?.migrations_dir !== expected.migrationsDir)',
    to: 'if (false && entry?.database_id !== expected.id || entry?.database_name !== expected.name || entry?.migrations_dir !== expected.migrationsDir)',
    target: "rejects an unsealed D1 database identity before migration listing",
    unrelated: "rejects a direct durable database-name migration lookup",
    testFile: "test/g30-b0.spec.ts",
    checkerRed: false,
  },
  {
    id: "receiver-public-surface",
    file: "samples/meeting-room/wrangler.g30-receiver-off.jsonc",
    from: '  "workers_dev": false,',
    to: '  "workers_dev": true,',
  },
  {
    id: "witness-capture-local-scope",
    file: "scripts/deploy/g30-b0-deploy.sh",
    from: '  local phase="$1"\n  local output="$2"\n  local prior="${output}.prior.versions.json"\n  local versions="${output}.versions.json"',
    to: '  local phase="$1" output="$2" prior="${output}.prior.versions.json" versions="${output}.versions.json"',
  },
  {
    id: "witness-replay-snapshot",
    file: "scripts/deploy/g30-b0-deploy.sh",
    from: '    --versions "${versions}" --prior-versions "${prior}" --output "${output}"',
    to: '    --versions "${versions}" --output "${output}"',
  },
  {
    id: "diagnostic-route-in-worker",
    file: "samples/meeting-room/src/worker.cloudflare-only.ts",
    from: '  if (url.pathname === "/conformance/v1/g32-store-state") {',
    to: '  if (url.pathname === "/conformance/v1/g30-config") return json({ task: "SDT-G30" });\n  if (url.pathname === "/conformance/v1/g32-store-state") {',
    target: "does not add a G30 diagnostic route or runtime variable to the authenticated Worker protocol",
    unrelated: "allows only head sampling to vary across the deployment configs",
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

function requireRed(result, id) {
  if (result.status !== 0) return;
  throw new Error(`G30 ${id} mutant was vacuous: phase-isolation checker remained green`);
}

function testNamed(name) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g30-b0.spec.ts",
    "--testNamePattern", name,
  ], `G30 config oracle ${name}`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G30 ${mutation.id} expected one mutation anchor in ${mutation.file}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function execute(mutation) {
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(run(process.execPath, [checker], "G30 phase-isolation baseline"));
    if (mutation.target !== undefined) requirePass(testNamed(mutation.target));
    writeFileSync(path, mutate(original, mutation), "utf8");
    if (mutation.file.endsWith(".sh")) requirePass(run("bash", ["-n", mutation.file], "G30 runbook syntax"));
    if (mutation.target !== undefined) {
      requireRed(testNamed(mutation.target), mutation.id);
      requirePass(testNamed(mutation.unrelated));
    }
    if (mutation.checkerRed !== false) requireRed(run(process.execPath, [checker], "G30 phase-isolation target oracle"), mutation.id);
    requirePass(run(process.execPath, [authority, "--check"], "G30 immutable bundle unrelated oracle"));
  } finally {
    writeFileSync(path, original, "utf8");
    requirePass(run(process.execPath, [checker], "G30 phase-isolation restoration"));
  }
  return { id: mutation.id, result: "red-with-authority-green" };
}

function main() {
  const ids = MUTATIONS.map((mutation) => mutation.id);
  if (new Set(ids).size !== ids.length) throw new Error("G30 config mutation IDs must be unique");
  const results = MUTATIONS.map(execute);
  console.log(JSON.stringify({ mutations: results, result: "all-production-config-mutants-red" }, null, 2));
}

main();

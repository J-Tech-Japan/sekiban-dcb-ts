#!/usr/bin/env node
/**
 * C-0 existing-resource operational reset for the G66 production sample.
 * Every Wrangler process is launched with all five recognized credential
 * names removed. The receipt stores commands and redacted process output,
 * never environment values or token material. No retry is made for a failed
 * state-changing invocation; an authorization-shaped failure gets exactly
 * one same-family d1-list classifier and then stops.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const PIPELINE_TABLES = Object.freeze([
  "serialized_dcb_global_receipts", "serialized_dcb_global_memberships", "serialized_dcb_event_arrivals", "dcb_event_ops", "dcb_events",
  "serialized_dcb_allocator_bindings", "serialized_dcb_completeness_findings", "serialized_dcb_completeness_scanner_health",
  "serialized_dcb_delivery_incidents", "serialized_dcb_inconsistency_findings", "serialized_dcb_lag_estimates", "serialized_dcb_live_poll_health",
  "serialized_dcb_pending_arrivals", "serialized_dcb_projection_checkpoints", "serialized_dcb_safe_lane_health", "serialized_dcb_safe_lane_history",
  "serialized_dcb_source_partitions", "serialized_dcb_wait_target_incidents", "serialized_dcb_hop_measurements", "serialized_dcb_hop_submeasurements",
]);
export const MV_TABLES = Object.freeze([
  "mv_active_generations", "mv_checkpoint_ahead_findings", "mv_index_entries", "mv_rows", "mv_unsafe_index_entries", "mv_unsafe_rows",
  "mv_wait_receipts", "mv_wait_target_poison", "mv_unsafe_arrivals", "mv_unsafe_kicks", "mv_unsafe_markers", "mv_unsafe_receipts",
  "mv_unsafe_failure_findings", "mv_atomic_guards", "mv_instances",
]);
const STRIPPED = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "WRANGLER_API_TOKEN"];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
function required(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
function sqlQuote(value) { return `'${value.replaceAll("'", "''")}'`; }
function strippedEnvironment() {
  const environment = { ...process.env };
  for (const name of STRIPPED) delete environment[name];
  return environment;
}
function writeReceipt(path, receipt) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}
function execute(options, args, kind) {
  const attemptedAt = new Date().toISOString();
  const result = spawnSync(options.wrangler, args, { encoding: "utf8", shell: false, env: strippedEnvironment() });
  return {
    kind,
    attemptedAt,
    command: [options.wrangler, ...args],
    exitCode: result.status,
    signal: result.signal,
    spawnError: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function authorizationShaped(invocation) {
  const text = `${invocation.stdout}\n${invocation.stderr}`;
  return /(?:\b7403\b|\b10000\b|unauthori[sz]|permission|forbidden)/i.test(text);
}
function countSql(table) {
  return `SELECT ${sqlQuote(table)} AS table_name, COUNT(*) AS row_count FROM ${table}`;
}
function run(options) {
  const receipt = {
    schema: "sdt-g66-c0-reset/v1",
    task: "SDT-G66",
    worker: options.worker,
    config: options.config,
    databases: { pipeline: options.pipeline, mv: options.mv },
    credentialEnvironment: Object.fromEntries(STRIPPED.map((name) => [name, process.env[name] === undefined ? "UNSET" : "SET"])),
    credentialHandling: "all five Wrangler-recognized names stripped from every child process; no token values persisted; no --keep-vars",
    operation: "C-0 operational-row reset; schema, migrations, DO namespaces, Queue and bindings preserved",
    pipelineTables: PIPELINE_TABLES,
    mvTables: MV_TABLES,
    invocations: [],
    status: "started",
  };
  const common = ["--remote", "--config", options.config, "--json"];
  const invoke = (database, command, kind) => {
    const invocation = execute(options, ["d1", "execute", database, ...common, "--command", command], kind);
    receipt.invocations.push(invocation);
    writeReceipt(options.output, receipt);
    if (invocation.exitCode !== 0) {
      if (authorizationShaped(invocation) && receipt.authorizationClassifier === undefined) {
        const classifier = execute(options, ["d1", "list", "--json"], "authorization-classifier-d1-list");
        receipt.authorizationClassifier = classifier;
        writeReceipt(options.output, receipt);
      }
      receipt.status = "blocked";
      receipt.failure = `${kind} failed; no state-changing retry was made`;
      writeReceipt(options.output, receipt);
      throw new Error(receipt.failure);
    }
    return invocation;
  };
  for (const table of PIPELINE_TABLES) invoke(options.pipeline, countSql(table), `pre-reset-pipeline-count-${table}`);
  for (const table of MV_TABLES) invoke(options.mv, countSql(table), `pre-reset-mv-count-${table}`);
  for (const table of PIPELINE_TABLES) invoke(options.pipeline, `DELETE FROM ${table}`, `delete-pipeline-${table}`);
  for (const table of MV_TABLES) invoke(options.mv, `DELETE FROM ${table}`, `delete-mv-${table}`);
  for (const table of PIPELINE_TABLES) invoke(options.pipeline, countSql(table), `post-reset-pipeline-count-${table}`);
  for (const table of MV_TABLES) invoke(options.mv, countSql(table), `post-reset-mv-count-${table}`);
  receipt.status = "completed";
  receipt.finishedAt = new Date().toISOString();
  writeReceipt(options.output, receipt);
  return receipt;
}

const options = {
  wrangler: required("--wrangler", argument("--wrangler", "/path/to/repo/node_modules/.bin/wrangler")),
  config: required("--config", argument("--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc")),
  worker: required("--worker", argument("--worker", "sekiban-dcb-meeting-room-cloudflare-only")),
  pipeline: required("--pipeline", argument("--pipeline", "sekiban-dcb-meeting-room-cloudflare-pipeline")),
  mv: required("--mv", argument("--mv", "sekiban-dcb-meeting-room-cloudflare-mv")),
  output: required("--output", argument("--output", ".artifacts/ci-local/g66-production-reset.json")),
};

try {
  const receipt = run(options);
  process.stdout.write(`${JSON.stringify({ task: receipt.task, status: receipt.status, output: resolve(options.output), invocationCount: receipt.invocations.length })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ task: "SDT-G66", status: "blocked", output: resolve(options.output), error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}

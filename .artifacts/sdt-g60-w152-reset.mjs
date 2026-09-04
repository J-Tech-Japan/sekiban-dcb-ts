#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PIPELINE_TABLES = [
  "serialized_dcb_global_receipts",
  "serialized_dcb_global_memberships",
  "serialized_dcb_event_arrivals",
  "dcb_event_ops",
  "dcb_events",
  "serialized_dcb_allocator_bindings",
  "serialized_dcb_completeness_findings",
  "serialized_dcb_completeness_scanner_health",
  "serialized_dcb_delivery_incidents",
  "serialized_dcb_inconsistency_findings",
  "serialized_dcb_lag_estimates",
  "serialized_dcb_live_poll_health",
  "serialized_dcb_pending_arrivals",
  "serialized_dcb_projection_checkpoints",
  "serialized_dcb_safe_lane_health",
  "serialized_dcb_safe_lane_history",
  "serialized_dcb_source_partitions",
  "serialized_dcb_wait_target_incidents",
  "serialized_dcb_hop_measurements",
  "serialized_dcb_hop_submeasurements",
];

const MV_TABLES = [
  "mv_active_generations",
  "mv_checkpoint_ahead_findings",
  "mv_index_entries",
  "mv_rows",
  "mv_unsafe_index_entries",
  "mv_unsafe_rows",
  "mv_wait_receipts",
  "mv_wait_target_poison",
  "mv_unsafe_arrivals",
  "mv_unsafe_kicks",
  "mv_unsafe_markers",
  "mv_unsafe_receipts",
  "mv_unsafe_failure_findings",
  "mv_atomic_guards",
  "mv_instances",
];

const STRIPPED_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function authFailure(text) {
  return /code\s*[:=]?\s*(?:7403|10000)|\bunauthorized\b|not authenticated|login required|oauth[^\n]{0,80}(?:fail|error|invalid|expired)|(?:auth|authentication)[^\n]{0,80}(?:fail|error|invalid|denied|required)/i.test(text);
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const variant = required("--variant", argument("--variant"));
const reportPath = resolve(required("--report", argument("--report")));
const config = resolve(required("--config", argument("--config")));
const wrangler = resolve(required("--wrangler", argument("--wrangler")));
const worker = "sekiban-dcb-meeting-room-cloudflare-only";
const strippedEnv = { ...process.env };
for (const name of STRIPPED_NAMES) delete strippedEnv[name];

const report = {
  schema: "sdt-g60-w152-clean-reset/v1",
  task: "SDT-G60-AUTHORITY-B-RETRY-W152",
  status: "running",
  variant,
  worker,
  config,
  wrangler,
  authorization: "C-0/C-13 authorized existing-resource operational reset; Authority-B retry after stripped read succeeded",
  tokenEnvironment: Object.fromEntries(STRIPPED_NAMES.map((name) => [name, strippedEnv[name] === undefined ? "UNSET" : "SET"])),
  credentialHandling: "All five Wrangler-recognized names removed; no conformance or observability token used; no --keep-vars",
  operation: {
    type: "full application-D1 operational reset",
    preserved: ["_cf_KV", "d1_migrations", "database schemas", "Queue", "outbox", "global-admission code/path", "Durable Object code"],
    notTouched: ["Queue", "outbox", "global-admission code/path", "worker source", "configuration"],
    pipelineTables: PIPELINE_TABLES,
    mvTables: MV_TABLES,
    sqlForm: "one explicit SELECT COUNT(*) or DELETE FROM statement per listed operational table; no DROP/DDL",
  },
  commands: [],
};

function persist() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function execute(label, database, sql) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(wrangler, [
    "d1", "execute", database,
    "--remote", "--json", "--yes",
    "--config", config,
    "--command", sql,
  ], { encoding: "utf8", env: strippedEnv });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const entry = {
    label,
    database,
    sql,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
    stdout,
    stderr,
    json: parseJson(stdout),
  };
  report.commands.push(entry);
  persist();
  const combined = `${stdout}\n${stderr}`;
  if (authFailure(combined)) {
    report.status = "blocked-auth-failure";
    report.failure = `${label} stopped after the first Cloudflare/OAuth/authentication failure`;
    persist();
    throw new Error(report.failure);
  }
  if (result.status !== 0) {
    report.status = "failed-reset-command";
    report.failure = `${label} exited ${String(result.status)}`;
    persist();
    throw new Error(report.failure);
  }
  return entry;
}

try {
  persist();
  for (const table of PIPELINE_TABLES) execute(`pre-reset-pipeline-${table}`, "D1", `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`);
  for (const table of MV_TABLES) execute(`pre-reset-mv-${table}`, "D1_MV", `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`);
  for (const table of PIPELINE_TABLES) execute(`delete-pipeline-${table}`, "D1", `DELETE FROM ${table}`);
  for (const table of MV_TABLES) execute(`delete-mv-${table}`, "D1_MV", `DELETE FROM ${table}`);
  for (const table of PIPELINE_TABLES) execute(`post-reset-pipeline-${table}`, "D1", `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`);
  for (const table of MV_TABLES) execute(`post-reset-mv-${table}`, "D1_MV", `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`);
  report.status = "completed";
  report.finishedAt = new Date().toISOString();
  persist();
  process.stdout.write(JSON.stringify({ status: report.status, variant, report: reportPath }) + "\n");
} catch (error) {
  report.finishedAt = new Date().toISOString();
  if (report.status === "running") {
    report.status = "failed-reset-script";
    report.failure = error instanceof Error ? error.message : String(error);
    persist();
  }
  process.stderr.write(`${report.status}: ${report.failure ?? (error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}

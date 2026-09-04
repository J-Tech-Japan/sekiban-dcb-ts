#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const STRIPPED_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];

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
  "serialized_dcb_unsafe_writer_boundaries",
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

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function isAuthorizationFailure(text) {
  return /code\s*[:=]?\s*(?:7403|10000)|\bunauthorized\b|not authenticated|login required|oauth[^\n]{0,100}(?:fail|error|invalid|expired)|(?:auth|authentication)[^\n]{0,100}(?:fail|error|invalid|denied|required)/i.test(text);
}

const reportPath = resolve(required("--report", argument("--report")));
const config = resolve(required("--config", argument("--config")));
const wrangler = resolve(required("--wrangler", argument("--wrangler")));
const strippedEnv = { ...process.env };
for (const name of STRIPPED_NAMES) delete strippedEnv[name];

const report = {
  schema: "sdt-g60-w154-migration-reset/v1",
  task: "SDT-G60-UNSAFE-WRITER-DEPLOYED-W154",
  status: "running",
  config,
  wrangler,
  bindings: { pipeline: "D1", materializedViews: "D1_MV" },
  tokenEnvironment: Object.fromEntries(STRIPPED_NAMES.map((name) => [name, strippedEnv[name] === undefined ? "UNSET" : "SET"])),
  noKeepVars: true,
  preserved: ["d1_migrations", "_cf_KV", "database schema", "Queue", "DLQ", "outbox configuration"],
  pipelineTables: PIPELINE_TABLES,
  mvTables: MV_TABLES,
  commands: [],
};

function persist() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function run(label, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(wrangler, args, { encoding: "utf8", env: strippedEnv });
  const entry = {
    label,
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    json: parseJson(result.stdout ?? ""),
  };
  report.commands.push(entry);
  persist();
  return entry;
}

function classifier(database, failedLabel) {
  const probe = run(`${failedLabel}-same-family-read-only-classifier`, [
    "d1", "execute", database,
    "--remote", "--json", "--yes",
    "--config", config,
    "--command", "SELECT 1 AS authorization_probe",
  ]);
  report.authorizationClassifier = {
    family: "d1",
    database,
    failedWriteLabel: failedLabel,
    command: probe.args,
    exitCode: probe.exitCode,
    stdout: probe.stdout,
    stderr: probe.stderr,
  };
  return probe;
}

function stopForEntry(entry, write) {
  const combined = `${entry.stdout}\n${entry.stderr}`;
  if (entry.exitCode === 0) return false;
  if (isAuthorizationFailure(combined)) {
    const probe = classifier(entry.args[2] === "D1_MV" ? "D1_MV" : "D1", entry.label);
    report.status = "blocked-auth-failure";
    report.failure = {
      kind: "authorization",
      write,
      label: entry.label,
      exactCommand: entry.args,
      writeExitCode: entry.exitCode,
      writeStdout: entry.stdout,
      writeStderr: entry.stderr,
      classifierExitCode: probe.exitCode,
    };
    persist();
    return true;
  }
  report.status = "failed-reset-command";
  report.failure = { write, label: entry.label, exactCommand: entry.args, exitCode: entry.exitCode };
  persist();
  return true;
}

function d1Execute(label, database, sql, write) {
  const entry = run(label, [
    "d1", "execute", database,
    "--remote", "--json", "--yes",
    "--config", config,
    "--command", sql,
  ]);
  return { entry, stopped: stopForEntry(entry, write) };
}

function countSql(table) {
  return `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`;
}

function deleteSql(table) {
  return `DELETE FROM ${table}`;
}

function runPhase(prefix, tables, database, operation, write) {
  for (const table of tables) {
    const value = d1Execute(`${prefix}-${table}`, database, operation(table), write);
    if (value.stopped) return false;
  }
  return true;
}

try {
  persist();
  const migration = run("apply-0008-g60-unsafe-writer-boundaries", [
    "d1", "migrations", "apply", "D1", "--remote", "--config", config,
  ]);
  if (stopForEntry(migration, true)) throw new Error(report.status);
  report.migration = { migration: "0008_g60_unsafe_writer_boundaries.sql", exitCode: migration.exitCode };
  persist();

  if (!runPhase("pre-reset-pipeline", PIPELINE_TABLES, "D1", countSql, false)) throw new Error(report.status);
  if (!runPhase("pre-reset-mv", MV_TABLES, "D1_MV", countSql, false)) throw new Error(report.status);
  if (!runPhase("delete-pipeline", PIPELINE_TABLES, "D1", deleteSql, true)) throw new Error(report.status);
  if (!runPhase("delete-mv", MV_TABLES, "D1_MV", deleteSql, true)) throw new Error(report.status);
  if (!runPhase("post-reset-pipeline", PIPELINE_TABLES, "D1", countSql, false)) throw new Error(report.status);
  if (!runPhase("post-reset-mv", MV_TABLES, "D1_MV", countSql, false)) throw new Error(report.status);

  report.status = "completed";
  report.finishedAt = new Date().toISOString();
  persist();
  process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath })}\n`);
} catch (error) {
  report.finishedAt = new Date().toISOString();
  if (report.status === "running") {
    report.status = "failed-reset-script";
    report.failure = error instanceof Error ? error.message : String(error);
    persist();
  }
  process.stderr.write(`${report.status}: ${JSON.stringify(report.failure ?? String(error))}\n`);
  process.exitCode = 1;
}

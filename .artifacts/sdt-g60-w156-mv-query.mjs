#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const names = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "WRANGLER_API_TOKEN"];
function arg(name, required = true) {
  const i = process.argv.indexOf(name);
  if (i < 0) { if (required) throw new Error(`${name} is required`); return null; }
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
const cohortPath = resolve(arg("--cohort"));
const reportPath = resolve(arg("--report"));
const config = resolve(arg("--config"));
const serviceId = arg("--service-id");
const sourceCommit = arg("--source-commit");
const wrangler = resolve(arg("--wrangler"));
const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
const events = (cohort.reservations ?? []).map((sample) => {
  const event = sample?.commit?.body?.response?.writtenEvents?.[0];
  return { ordinal: sample.ordinal, reservationId: sample.reservationId, eventId: event?.id ?? null, suid: event?.sortableUniqueIdValue ?? sample.suid ?? null };
});
if (events.length !== 10 || events.some((event) => typeof event.eventId !== "string" || typeof event.suid !== "string")) throw new Error("expected ten complete event/SUID identities");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const eventList = events.map((event) => quote(event.eventId)).join(", ");
const suidList = events.map((event) => quote(event.suid)).join(", ");
const sql = [
  "SELECT 'unsafe_receipt' AS record_kind, service_id, view_id, event_id, suid, outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, 0 AS generation, '' AS last_suid, '' AS status FROM mv_unsafe_receipts WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ")",
  "SELECT 'mv_rows' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, 0 AS observed_at, row_key, source_suid, value_json, generation, '' AS last_suid, '' AS status FROM mv_rows WHERE service_id = " + quote(serviceId) + " AND source_suid IN (" + suidList + ")",
  "SELECT 'mv_unsafe_rows' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, CAST(tombstone AS TEXT) AS outcome, 0 AS observed_at, row_key, source_suid, value_json, generation, '' AS last_suid, '' AS status FROM mv_unsafe_rows WHERE service_id = " + quote(serviceId) + " AND source_suid IN (" + suidList + ")",
  "SELECT 'mv_instance' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, updated_at AS observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, last_suid, status FROM mv_instances WHERE service_id = " + quote(serviceId) + " ORDER BY view_id, generation",
  "SELECT 'mv_active_generation' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, updated_at AS observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, '' AS last_suid, '' AS status FROM mv_active_generations WHERE service_id = " + quote(serviceId) + " ORDER BY view_id",
  "SELECT 'mv_unsafe_arrival' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, CAST(rebuild_required AS TEXT) AS outcome, 0 AS observed_at, '' AS row_key, arrival_watermark AS source_suid, '' AS value_json, generation, safe_head AS last_suid, '' AS status FROM mv_unsafe_arrivals WHERE service_id = " + quote(serviceId) + " ORDER BY view_id, generation",
  "SELECT 'mv_wait_receipt' AS record_kind, * FROM mv_wait_receipts WHERE service_id = " + quote(serviceId) + " ORDER BY rowid",
  "SELECT 'mv_unsafe_kick' AS record_kind, * FROM mv_unsafe_kicks WHERE service_id = " + quote(serviceId) + " ORDER BY rowid",
  "SELECT 'mv_unsafe_marker' AS record_kind, * FROM mv_unsafe_markers WHERE service_id = " + quote(serviceId) + " ORDER BY rowid",
].join("; ");

function authFailure(text) {
  return /code\s*[:=]?\s*(?:7403|10000)|\bunauthorized\b|not authenticated|login required|oauth[^\n]{0,100}(?:fail|error|invalid|expired)|(?:auth|authentication)[^\n]{0,100}(?:fail|error|invalid|denied|required)/i.test(text);
}
const env = { ...process.env };
for (const name of names) delete env[name];
function run(args) {
  const result = spawnSync(wrangler, args, { encoding: "utf8", env });
  return { args, exitCode: result.status, signal: result.signal ?? null, spawnError: result.error?.message ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const command = run(["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", sql]);
const report = {
  schema: "sdt-g60-w156-mv/v1",
  task: "SDT-G60-QUEUE-BYPASS-LEVERS-W156",
  serviceId, sourceCommit, config, wrangler, cohortPath, cohortEvents: events, sql,
  tokenEnvironment: Object.fromEntries(names.map((name) => [name, env[name] === undefined ? "UNSET" : "SET"])),
  noKeepVars: true, command, parsed: null, status: command.exitCode === 0 ? "completed" : "failed",
};
if (command.exitCode === 0) {
  try { report.parsed = JSON.parse(command.stdout); } catch { report.parseError = "stdout was not JSON"; }
} else if (authFailure(command.stdout + "\n" + command.stderr)) {
  report.authorizationClassifier = run(["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", "SELECT 1 AS authorization_probe"]);
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
if (report.status !== "completed") process.exitCode = command.exitCode || 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed?.length ?? null }) + "\n");

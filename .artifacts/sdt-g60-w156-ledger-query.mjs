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
const sql = [
  "SELECT 'hop' AS ledger, service_id, event_id, suid, attempt_id, stage, '' AS boundary, '' AS outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path FROM serialized_dcb_hop_measurements WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ")",
  "UNION ALL SELECT 'sub' AS ledger, service_id, event_id, suid, attempt_id, stage, boundary, outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path FROM serialized_dcb_hop_submeasurements WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ")",
  "UNION ALL SELECT 'unsafe-writer' AS ledger, service_id, event_id, suid, attempt_id, '' AS stage, boundary, outcome, '' AS partition_tag, view_id, transport, observed_at, writer_path FROM serialized_dcb_unsafe_writer_boundaries WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ") ORDER BY event_id COLLATE BINARY, observed_at ASC, ledger COLLATE BINARY, stage COLLATE BINARY, boundary COLLATE BINARY, view_id COLLATE BINARY, transport COLLATE BINARY",
  "SELECT 'scanner-health' AS record_kind, service_id, scanner_version, status, cursor_json, last_full_scan_at, last_error, updated_at FROM serialized_dcb_completeness_scanner_health WHERE service_id = " + quote(serviceId) + " ORDER BY updated_at ASC",
  "SELECT 'completeness-finding' AS record_kind, service_id, incident_identity, incident_type, partition_tag, obligation_sequence, event_id, event_digest, state, first_observed_at, last_observed_at FROM serialized_dcb_completeness_findings WHERE service_id = " + quote(serviceId) + " ORDER BY first_observed_at ASC",
  "SELECT 'source-partition' AS record_kind, service_id, partition_tag, last_obligation_sequence, registered_at FROM serialized_dcb_source_partitions WHERE service_id = " + quote(serviceId) + " ORDER BY registered_at ASC, partition_tag COLLATE BINARY",
  "SELECT 'safe-lane-health' AS record_kind, * FROM serialized_dcb_safe_lane_health WHERE service_id = " + quote(serviceId) + " ORDER BY observed_at ASC",
  "SELECT 'safe-lane-history' AS record_kind, * FROM serialized_dcb_safe_lane_history WHERE service_id = " + quote(serviceId) + " ORDER BY observed_at ASC",
  "SELECT 'live-poll-health' AS record_kind, * FROM serialized_dcb_live_poll_health WHERE service_id = " + quote(serviceId) + " ORDER BY observed_at ASC",
  "SELECT 'projection-checkpoint' AS record_kind, * FROM serialized_dcb_projection_checkpoints WHERE service_id = " + quote(serviceId) + " ORDER BY updated_at ASC",
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
const command = run(["d1", "execute", "D1", "--remote", "--json", "--yes", "--config", config, "--command", sql]);
const report = {
  schema: "sdt-g60-w156-ledger/v1",
  task: "SDT-G60-QUEUE-BYPASS-LEVERS-W156",
  serviceId, sourceCommit, config, wrangler, cohortPath, cohortEvents: events, sql,
  tokenEnvironment: Object.fromEntries(names.map((name) => [name, env[name] === undefined ? "UNSET" : "SET"])),
  noKeepVars: true, command, parsed: null, status: command.exitCode === 0 ? "completed" : "failed",
};
if (command.exitCode === 0) {
  try { report.parsed = JSON.parse(command.stdout); } catch { report.parseError = "stdout was not JSON"; }
} else if (authFailure(command.stdout + "\n" + command.stderr)) {
  report.authorizationClassifier = run(["d1", "execute", "D1", "--remote", "--json", "--yes", "--config", config, "--command", "SELECT 1 AS authorization_probe"]);
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
if (report.status !== "completed") process.exitCode = command.exitCode || 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed?.length ?? null }) + "\n");

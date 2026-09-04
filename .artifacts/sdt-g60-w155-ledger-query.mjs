#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cohortPath = resolve(root, ".artifacts/sdt-g60-w155-public-cohort.json");
const reportPath = resolve(root, ".artifacts/sdt-g60-w155-ledger.json");
const config = resolve(root, ".artifacts/sdt-g60-w155-wrangler.cloudflare-only.jsonc");
const wrangler = "/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler";
const serviceId = "sekiban-dcb-g60-w155-c";
const sourceCommit = "31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf";
const strippedNames = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "WRANGLER_API_TOKEN"];
const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
const events = (cohort.reservations || []).map((sample) => {
  const event = sample && sample.commit && sample.commit.body && sample.commit.body.response && sample.commit.body.response.writtenEvents && sample.commit.body.response.writtenEvents[0];
  return { ordinal: sample.ordinal, reservationId: sample.reservationId, eventId: event && event.id || null, suid: event && event.sortableUniqueIdValue || sample.suid || null };
});
if (events.length !== 10 || events.some((event) => typeof event.eventId !== "string" || typeof event.suid !== "string")) throw new Error("expected ten complete event/SUID identities");

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const eventList = events.map((event) => quote(event.eventId)).join(", ");
const sql = [
  "SELECT 'hop' AS ledger, service_id, event_id, suid, attempt_id, stage, '' AS boundary, '' AS outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path",
  "FROM serialized_dcb_hop_measurements",
  "WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ")",
  "UNION ALL",
  "SELECT 'sub' AS ledger, service_id, event_id, suid, attempt_id, stage, boundary, outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path",
  "FROM serialized_dcb_hop_submeasurements",
  "WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ")",
  "UNION ALL",
  "SELECT 'unsafe-writer' AS ledger, service_id, event_id, suid, attempt_id, '' AS stage, boundary, outcome, '' AS partition_tag, view_id, transport, observed_at, writer_path",
  "FROM serialized_dcb_unsafe_writer_boundaries",
  "WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ")",
  "ORDER BY event_id COLLATE BINARY, observed_at ASC, ledger COLLATE BINARY, stage COLLATE BINARY, boundary COLLATE BINARY, partition_tag COLLATE BINARY, view_id COLLATE BINARY, transport COLLATE BINARY;",
  "SELECT 'scanner-health' AS record_kind, service_id, scanner_version, status, cursor_json, last_full_scan_at, last_error, updated_at FROM serialized_dcb_completeness_scanner_health WHERE service_id = " + quote(serviceId) + " ORDER BY updated_at ASC;",
  "SELECT 'completeness-finding' AS record_kind, service_id, incident_identity, incident_type, partition_tag, obligation_sequence, event_id, event_digest, state, first_observed_at, last_observed_at FROM serialized_dcb_completeness_findings WHERE service_id = " + quote(serviceId) + " ORDER BY first_observed_at ASC;",
  "SELECT 'source-partition' AS record_kind, service_id, partition_tag, last_obligation_sequence, registered_at FROM serialized_dcb_source_partitions WHERE service_id = " + quote(serviceId) + " ORDER BY registered_at ASC, partition_tag COLLATE BINARY;",
  "SELECT 'safe-lane-health' AS record_kind, * FROM serialized_dcb_safe_lane_health WHERE service_id = " + quote(serviceId) + " ORDER BY observed_at ASC;",
  "SELECT 'projection-checkpoint' AS record_kind, * FROM serialized_dcb_projection_checkpoints WHERE service_id = " + quote(serviceId) + " ORDER BY updated_at ASC",
].join(" ");

function isAuthorizationFailure(text) {
  return /code\\s*[:=]?\\s*(?:7403|10000)|\\bunauthorized\\b|not authenticated|login required|oauth[^\\n]{0,100}(?:fail|error|invalid|expired)|(?:auth|authentication)[^\\n]{0,100}(?:fail|error|invalid|denied|required)/i.test(text);
}

const strippedEnv = { ...process.env };
for (const name of strippedNames) delete strippedEnv[name];
function run(args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(wrangler, args, { encoding: "utf8", env: strippedEnv });
  return {
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal || null,
    spawnError: result.error && result.error.message || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const command = run(["d1", "execute", "D1", "--remote", "--json", "--yes", "--config", config, "--command", sql]);
const report = {
  schema: "sdt-g60-w155-ledger/v1",
  task: "SDT-G60-FRESH-UNSAFE-PROOF-W155",
  serviceId,
  sourceCommit,
  config,
  wrangler,
  tokenEnvironment: Object.fromEntries(strippedNames.map((name) => [name, strippedEnv[name] === undefined ? "UNSET" : "SET"])),
  cohortEvents: events,
  sql,
  command,
  parsed: null,
  status: command.exitCode === 0 ? "completed" : "failed",
};
if (command.exitCode === 0) {
  try { report.parsed = JSON.parse(command.stdout); } catch { report.parsed = null; }
} else if (isAuthorizationFailure(command.stdout + "\\n" + command.stderr)) {
  report.authorizationClassifier = run(["d1", "execute", "D1", "--remote", "--json", "--yes", "--config", config, "--command", "SELECT 1 AS authorization_probe"]);
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
if (report.status !== "completed") process.exitCode = command.exitCode || 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed && report.parsed.length || null }) + "\n");

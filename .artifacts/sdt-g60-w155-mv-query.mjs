#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cohortPath = resolve(root, ".artifacts/sdt-g60-w155-public-cohort.json");
const reportPath = resolve(root, ".artifacts/sdt-g60-w155-mv.json");
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
const suidList = events.map((event) => quote(event.suid)).join(", ");
const sql = [
  "SELECT 'unsafe_receipt' AS record_kind, service_id, view_id, event_id, suid, outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, 0 AS generation, '' AS last_suid, '' AS status FROM mv_unsafe_receipts WHERE service_id = " + quote(serviceId) + " AND event_id IN (" + eventList + ");",
  "SELECT 'mv_rows' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, 0 AS observed_at, row_key, source_suid, value_json, generation, '' AS last_suid, '' AS status FROM mv_rows WHERE service_id = " + quote(serviceId) + " AND source_suid IN (" + suidList + ");",
  "SELECT 'mv_unsafe_rows' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, CAST(tombstone AS TEXT) AS outcome, 0 AS observed_at, row_key, source_suid, value_json, generation, '' AS last_suid, '' AS status FROM mv_unsafe_rows WHERE service_id = " + quote(serviceId) + " AND source_suid IN (" + suidList + ");",
  "SELECT 'mv_instance' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, updated_at AS observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, last_suid, status FROM mv_instances WHERE service_id = " + quote(serviceId) + " ORDER BY view_id, generation;",
  "SELECT 'mv_active_generation' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, updated_at AS observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, '' AS last_suid, '' AS status FROM mv_active_generations WHERE service_id = " + quote(serviceId) + " ORDER BY view_id;",
  "SELECT 'mv_unsafe_arrival' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, CAST(rebuild_required AS TEXT) AS outcome, 0 AS observed_at, '' AS row_key, arrival_watermark AS source_suid, '' AS value_json, generation, safe_head AS last_suid, '' AS status FROM mv_unsafe_arrivals WHERE service_id = " + quote(serviceId) + " ORDER BY view_id, generation;",
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
const command = run(["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", sql]);
const report = {
  schema: "sdt-g60-w155-mv/v1",
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
  report.authorizationClassifier = run(["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", "SELECT 1 AS authorization_probe"]);
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
if (report.status !== "completed") process.exitCode = command.exitCode || 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed && report.parsed.length || null }) + "\n");

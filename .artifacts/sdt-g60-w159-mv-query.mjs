#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const STRIPPED_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];
const root = process.cwd();
const cohortPath = resolve(root, ".artifacts/sdt-g60-w159-public-cohort.json");
const reportPath = resolve(root, ".artifacts/sdt-g60-w159-mv.json");
const config = resolve(root, ".artifacts/sdt-g60-w159-wrangler.cloudflare-only.jsonc");
const wrangler = "/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler";
const serviceId = "sekiban-dcb-g60-w131-c";
const sourceCommit = "6481ddf4285b5bd71b576aee4a02e0605fb102b1";
const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
const events = (cohort.reservations ?? []).map((sample) => {
  const event = sample?.commit?.body?.response?.writtenEvents?.[0];
  return {
    ordinal: sample.ordinal,
    reservationId: sample.reservationId,
    eventId: event?.id ?? null,
    suid: event?.sortableUniqueIdValue ?? sample.suid ?? null,
  };
});
if (events.length !== 10 || events.some((event) => typeof event.eventId !== "string" || typeof event.suid !== "string")) {
  throw new Error("expected ten complete event/SUID identities");
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const eventList = events.map((event) => quote(event.eventId)).join(", ");
const suidList = events.map((event) => quote(event.suid)).join(", ");
const sql = [
  `SELECT 'unsafe-receipt' AS record_kind, service_id, view_id, event_id, suid, outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, 0 AS generation, '' AS last_suid, '' AS tombstone FROM mv_unsafe_receipts WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'mv-row' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, 0 AS observed_at, row_key, source_suid, value_json, generation, '' AS last_suid, 0 AS tombstone FROM mv_rows WHERE service_id = ${quote(serviceId)} AND source_suid IN (${suidList}) ORDER BY source_suid COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'unsafe-row' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, 0 AS observed_at, row_key, source_suid, value_json, generation, '' AS last_suid, tombstone FROM mv_unsafe_rows WHERE service_id = ${quote(serviceId)} AND source_suid IN (${suidList}) ORDER BY source_suid COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'unsafe-marker' AS record_kind, service_id, view_id, event_id, suid, reason AS outcome, 0 AS observed_at, row_key, '' AS source_suid, '' AS value_json, generation, '' AS last_suid, 0 AS tombstone FROM mv_unsafe_markers WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'unsafe-arrival' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, CAST(rebuild_required AS TEXT) AS outcome, 0 AS observed_at, '' AS row_key, arrival_watermark AS source_suid, '' AS value_json, generation, safe_head AS last_suid, 0 AS tombstone FROM mv_unsafe_arrivals WHERE service_id = ${quote(serviceId)} ORDER BY view_id COLLATE BINARY, generation;`,
  `SELECT 'unsafe-failure' AS record_kind, service_id, view_id, event_id, suid, classification AS outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, 0 AS generation, '' AS last_suid, 0 AS tombstone FROM mv_unsafe_failure_findings WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'wait-receipt' AS record_kind, service_id, view_id, event_id, suid, '' AS outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, '' AS last_suid, 0 AS tombstone FROM mv_wait_receipts WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'wait-poison' AS record_kind, service_id, view_id, event_id, suid, classification AS outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, '' AS last_suid, 0 AS tombstone FROM mv_wait_target_poison WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, view_id COLLATE BINARY;`,
  `SELECT 'mv-instance' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, status AS outcome, updated_at AS observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, last_suid, 0 AS tombstone FROM mv_instances WHERE service_id = ${quote(serviceId)} ORDER BY view_id COLLATE BINARY, generation;`,
  `SELECT 'mv-active-generation' AS record_kind, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, updated_at AS observed_at, '' AS row_key, '' AS source_suid, '' AS value_json, generation, '' AS last_suid, 0 AS tombstone FROM mv_active_generations WHERE service_id = ${quote(serviceId)} ORDER BY view_id COLLATE BINARY;`,
].join(" ");

const originalEnvironment = process.env;
const cleanedEnvironment = { ...originalEnvironment };
const tokenEnvironment = {};
for (const name of STRIPPED_NAMES) {
  tokenEnvironment[name] = Object.prototype.hasOwnProperty.call(originalEnvironment, name) ? "SET" : "UNSET";
  delete cleanedEnvironment[name];
}

function run(args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(wrangler, args, { encoding: "utf8", env: cleanedEnvironment });
  return {
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function containsAuth7403Or10000(value) {
  return /code\s*[:=]?\s*(?:7403|10000)/i.test(value);
}

function containsOtherAuth(value) {
  return /\bunauthorized\b|not authenticated|login required|oauth[^\n]{0,100}(?:fail|error|invalid|expired)|(?:auth|authentication)[^\n]{0,100}(?:fail|error|invalid|denied|required)/i.test(value);
}

function parseOutput(value) {
  const trimmed = value.trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.lastIndexOf("[");
  if (start >= 0) {
    try { return JSON.parse(trimmed.slice(start)); } catch {}
  }
  return null;
}

const args = ["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", sql];
const attempts = [run(args)];
for (const delayMs of [5000, 20000, 60000]) {
  const latest = attempts[attempts.length - 1];
  if (latest.exitCode === 0 || !containsAuth7403Or10000(`${latest.stdout}\n${latest.stderr}`)) break;
  await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
  attempts.push(run(args));
}
const latest = attempts[attempts.length - 1];
const report = {
  schema: "sdt-g60-w159-mv/v1",
  task: "SDT-G60-REUSED-ARM-DEPLOYED-W159",
  serviceId,
  sourceCommit,
  config,
  wrangler,
  tokenEnvironment,
  noKeepVars: true,
  cohortEvents: events,
  sql,
  attempts,
  parsed: latest.exitCode === 0 ? parseOutput(latest.stdout) : null,
  status: latest.exitCode === 0 ? "completed" : "failed",
};
if (latest.exitCode !== 0 && !containsAuth7403Or10000(`${latest.stdout}\n${latest.stderr}`) && containsOtherAuth(`${latest.stdout}\n${latest.stderr}`)) {
  report.authorizationClassifier = run(["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", "SELECT 1 AS authorization_probe"]);
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "completed") process.exitCode = latest.exitCode ?? 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed?.length ?? null }) + "\n");

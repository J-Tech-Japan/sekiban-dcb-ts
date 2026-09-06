#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const strippedNames = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(name) {
  const value = arg(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function auth7403Or10000(text) {
  return /code\s*[:=]?\s*(?:7403|10000)/i.test(text);
}

function otherAuth(text) {
  return /\bunauthorized\b|not authenticated|login required|oauth[^\n]{0,100}(?:fail|error|invalid|expired)|(?:auth|authentication)[^\n]{0,100}(?:fail|error|invalid|denied|required)/i.test(text);
}

const cohortPath = resolve(required("--cohort"));
const reportPath = resolve(required("--report"));
const config = resolve(required("--config"));
const serviceId = required("--service-id");
const sourceCommit = required("--source-commit");
const database = arg("--database", "D1");
const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
const samples = Array.isArray(cohort.reservations) ? cohort.reservations : [];
const setupEvent = (cohort.setupRoom?.response?.body ?? cohort.setupRoom?.commit?.body)?.response?.writtenEvents?.[0];
const events = [
  setupEvent === undefined ? null : {
    role: "setup-room",
    ordinal: 0,
    reservationId: null,
    eventId: setupEvent.id ?? null,
    suid: setupEvent.sortableUniqueIdValue ?? null,
  },
  ...samples.map((sample) => {
    const event = (sample?.commit?.rawResponse?.body ?? sample?.commit?.body)?.response?.writtenEvents?.[0];
    return {
      role: "reservation",
      ordinal: sample?.ordinal ?? null,
      reservationId: sample?.reservationId ?? null,
      eventId: event?.id ?? null,
      suid: event?.sortableUniqueIdValue ?? sample?.suid ?? null,
    };
  }),
].filter((event) => typeof event?.eventId === "string" && typeof event?.suid === "string");
if (events.length !== samples.length + 1) throw new Error("cohort is missing stable setup/event/SUID identities");

const eventList = events.map((event) => quote(event.eventId)).join(", ");
const sql = [
  `SELECT 'event' AS record_kind, "ServiceId" AS service_id, "Id" AS event_id, "SortableUniqueId" AS suid, "Timestamp" AS authored_timestamp, "Tags" AS tags FROM dcb_events WHERE "ServiceId" = ${quote(serviceId)} AND "Id" IN (${eventList}) ORDER BY "SortableUniqueId" COLLATE BINARY;`,
  `SELECT 'global-receipt' AS record_kind, service_id, event_id, event_digest, membership_tag AS partition_tag, obligation_sequence, received_at FROM serialized_dcb_global_receipts WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, membership_tag COLLATE BINARY, obligation_sequence;`,
  `SELECT 'admission' AS record_kind, service_id, event_id, suid, attempt_id, partition_tag, delivery_source, admission_started_at, admission_finished_at, outcome, global_completion_observed_at, clock_origin FROM serialized_dcb_g65_admission_attempts WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, admission_started_at ASC, partition_tag COLLATE BINARY;`,
  `SELECT 'hop' AS ledger, service_id, event_id, suid, attempt_id, stage, '' AS boundary, '' AS outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path FROM serialized_dcb_hop_measurements WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) UNION ALL SELECT 'sub' AS ledger, service_id, event_id, suid, attempt_id, stage, boundary, outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path FROM serialized_dcb_hop_submeasurements WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) UNION ALL SELECT 'unsafe-writer' AS ledger, service_id, event_id, suid, attempt_id, '' AS stage, boundary, outcome, '' AS partition_tag, view_id, transport, observed_at, writer_path FROM serialized_dcb_unsafe_writer_boundaries WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, observed_at ASC, ledger COLLATE BINARY, stage COLLATE BINARY, boundary COLLATE BINARY, view_id COLLATE BINARY, transport COLLATE BINARY;`,
  `SELECT 'source-partition' AS record_kind, service_id, partition_tag, last_obligation_sequence, registered_at FROM serialized_dcb_source_partitions WHERE service_id = ${quote(serviceId)} ORDER BY registered_at ASC, partition_tag COLLATE BINARY;`,
].join(" ");

const originalEnv = process.env;
const cleanedEnv = { ...originalEnv };
const tokenEnvironment = {};
for (const name of strippedNames) {
  tokenEnvironment[name] = Object.prototype.hasOwnProperty.call(originalEnv, name) ? "SET" : "UNSET";
  delete cleanedEnv[name];
}
const wrangler = resolve("./node_modules/.bin/wrangler");
const args = ["d1", "execute", database, "--remote", "--json", "--yes", "--config", config, "--command", sql];

function run() {
  const startedAt = new Date().toISOString();
  const result = spawnSync(wrangler, args, { encoding: "utf8", env: cleanedEnv });
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

const attempts = [run()];
for (const delayMs of [5000, 20000, 60000]) {
  const latest = attempts.at(-1);
  if (latest.exitCode === 0 || !auth7403Or10000(`${latest.stdout}\n${latest.stderr}`)) break;
  await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
  attempts.push(run());
}
const latest = attempts.at(-1);
const report = {
  schema: "sdt-g65-w130-ledger/v1",
  task: "SDT-G65-PR127-DEPLOYED-REPAIR-WAKE-130",
  serviceId,
  sourceCommit,
  config,
  database,
  wrangler,
  tokenEnvironment,
  noKeepVars: true,
  cohortPath,
  cohortEvents: events,
  sql,
  attempts,
  parsed: latest.exitCode === 0 ? (() => { try { return JSON.parse(latest.stdout); } catch { return null; } })() : null,
  status: latest.exitCode === 0 ? "completed" : "failed",
};
if (latest.exitCode !== 0 && !auth7403Or10000(`${latest.stdout}\n${latest.stderr}`) && otherAuth(`${latest.stdout}\n${latest.stderr}`)) {
  report.authorizationClassifier = {
    note: "WAKE-108 same-family read-only classifier was not run automatically; preserve this failure for the task stop decision.",
  };
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "completed") process.exitCode = latest.exitCode || 1;
else process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed?.length ?? null })}\n`);

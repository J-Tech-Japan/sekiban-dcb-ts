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
const reportPath = resolve(root, ".artifacts/sdt-g60-w159-ledger.json");
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
const sql = [
  "SELECT 'hop' AS record_kind, service_id, event_id, suid, attempt_id, stage, '' AS boundary, '' AS outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path FROM serialized_dcb_hop_measurements",
  `WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList})`,
  "UNION ALL SELECT 'sub' AS record_kind, service_id, event_id, suid, attempt_id, stage, boundary, outcome, partition_tag, view_id, transport, observed_at, '' AS writer_path FROM serialized_dcb_hop_submeasurements",
  `WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList})`,
  "UNION ALL SELECT 'unsafe-writer' AS record_kind, service_id, event_id, suid, attempt_id, '' AS stage, boundary, outcome, '' AS partition_tag, view_id, transport, observed_at, writer_path FROM serialized_dcb_unsafe_writer_boundaries",
  `WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList})`,
  "ORDER BY event_id COLLATE BINARY, observed_at ASC, record_kind COLLATE BINARY, stage COLLATE BINARY, boundary COLLATE BINARY, partition_tag COLLATE BINARY, view_id COLLATE BINARY, transport COLLATE BINARY;",
  `SELECT 'source-event' AS record_kind, event."Id" AS event_id, event."SortableUniqueId" AS suid, event."EventType" AS event_type, event."Timestamp" AS event_timestamp, event."Tags" AS tags FROM dcb_events AS event WHERE event."ServiceId" = ${quote(serviceId)} AND event."Id" IN (${eventList}) ORDER BY event."Id" COLLATE BINARY;`,
  `SELECT 'event-op' AS record_kind, "Id" AS event_id, "AttemptId" AS attempt_id, "AllocatorLineageId" AS allocator_lineage_id, "FirstArrivedAt" AS first_arrived_at, "LastArrivedAt" AS last_arrived_at, "MaxDeliveryLagMs" AS max_delivery_lag_ms FROM dcb_event_ops WHERE "ServiceId" = ${quote(serviceId)} AND "Id" IN (${eventList}) ORDER BY "Id" COLLATE BINARY;`,
  `SELECT 'event-arrival' AS record_kind, service_id, event_id, tag, enqueued_at, arrived_at, lag_ms FROM serialized_dcb_event_arrivals WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, tag COLLATE BINARY;`,
  `SELECT 'global-membership' AS record_kind, service_id, event_id, partition_tag, event_digest, committed_at FROM serialized_dcb_global_memberships WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, partition_tag COLLATE BINARY;`,
  `SELECT 'global-receipt' AS record_kind, service_id, partition_tag, obligation_sequence, event_id, event_digest, membership_tag, received_at FROM serialized_dcb_global_receipts WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList}) ORDER BY event_id COLLATE BINARY, membership_tag COLLATE BINARY;`,
  `SELECT 'scanner-health' AS record_kind, service_id, scanner_version, status, cursor_json, last_full_scan_at, last_error, updated_at FROM serialized_dcb_completeness_scanner_health WHERE service_id = ${quote(serviceId)} ORDER BY updated_at ASC;`,
  `SELECT 'completeness-finding' AS record_kind, service_id, incident_identity, incident_type, partition_tag, obligation_sequence, event_id, event_digest, state, first_observed_at, last_observed_at FROM serialized_dcb_completeness_findings WHERE service_id = ${quote(serviceId)} ORDER BY first_observed_at ASC;`,
  `SELECT 'source-partition' AS record_kind, service_id, partition_tag, last_obligation_sequence, registered_at FROM serialized_dcb_source_partitions WHERE service_id = ${quote(serviceId)} ORDER BY registered_at ASC, partition_tag COLLATE BINARY;`,
  `SELECT 'safe-lane-health' AS record_kind, service_id, coverage_kind, coverage_reason, coverage_partition_tag, settled_frontier_suid, observed_at FROM serialized_dcb_safe_lane_health WHERE service_id = ${quote(serviceId)};`,
  `SELECT 'safe-lane-history' AS record_kind, service_id, tick_id, coverage_kind, coverage_reason, coverage_partition_tag, settled_frontier_suid, observed_at FROM serialized_dcb_safe_lane_history WHERE service_id = ${quote(serviceId)} ORDER BY observed_at ASC, tick_id COLLATE BINARY;`,
  `SELECT 'live-poll' AS record_kind, service_id, projector_id, attempted_at, outcome, reason, advanced_source_events FROM serialized_dcb_live_poll_health WHERE service_id = ${quote(serviceId)} ORDER BY attempted_at ASC, projector_id COLLATE BINARY;`,
  `SELECT 'projection-checkpoint' AS record_kind, service_id, projection_id, last_suid, state_json, version, updated_at FROM serialized_dcb_projection_checkpoints WHERE service_id = ${quote(serviceId)} ORDER BY updated_at ASC, projection_id COLLATE BINARY;`,
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

const args = ["d1", "execute", "D1", "--remote", "--json", "--yes", "--config", config, "--command", sql];
const attempts = [run(args)];
for (const delayMs of [5000, 20000, 60000]) {
  const latest = attempts[attempts.length - 1];
  if (latest.exitCode === 0 || !containsAuth7403Or10000(`${latest.stdout}\n${latest.stderr}`)) break;
  await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
  attempts.push(run(args));
}
const latest = attempts[attempts.length - 1];
const report = {
  schema: "sdt-g60-w159-ledger/v1",
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
  report.authorizationClassifier = run(["d1", "execute", "D1", "--remote", "--json", "--yes", "--config", config, "--command", "SELECT 1 AS authorization_probe"]);
  report.status = "blocked-auth-failure";
}
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status !== "completed") process.exitCode = latest.exitCode ?? 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed?.length ?? null }) + "\n");

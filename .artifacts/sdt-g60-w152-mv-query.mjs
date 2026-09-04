#!/usr/bin/env node

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
const cohortPath = resolve(root, ".artifacts/sdt-g60-w152-public-cohort.json");
const reportPath = resolve(root, ".artifacts/sdt-g60-w152-mv.json");
const config = resolve(root, "samples/meeting-room/wrangler.cloudflare-only.jsonc");
const wrangler = "/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler";
const serviceId = "sekiban-dcb-meeting-room-cloudflare-only";
const sourceCommit = "4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2";
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
  "SELECT 'unsafe_receipt' AS ledger, service_id, view_id, event_id, suid, outcome, observed_at, '' AS row_key, '' AS source_suid, '' AS value_json FROM mv_unsafe_receipts",
  `WHERE service_id = ${quote(serviceId)} AND event_id IN (${eventList})`,
  "UNION ALL",
  "SELECT 'mv_rows' AS ledger, service_id, view_id, '' AS event_id, '' AS suid, '' AS outcome, 0 AS observed_at, row_key, source_suid, value_json FROM mv_rows",
  `WHERE service_id = ${quote(serviceId)} AND source_suid IN (${suidList})`,
  "UNION ALL",
  "SELECT 'mv_unsafe_rows' AS ledger, service_id, view_id, '' AS event_id, '' AS suid, CAST(tombstone AS TEXT) AS outcome, 0 AS observed_at, row_key, source_suid, value_json FROM mv_unsafe_rows",
  `WHERE service_id = ${quote(serviceId)} AND source_suid IN (${suidList})`,
  "ORDER BY ledger COLLATE BINARY, event_id COLLATE BINARY, observed_at ASC, view_id COLLATE BINARY, row_key COLLATE BINARY",
].join(" ");
const strippedEnv = { ...process.env };
for (const name of STRIPPED_NAMES) delete strippedEnv[name];
const args = ["d1", "execute", "D1_MV", "--remote", "--json", "--yes", "--config", config, "--command", sql];
const startedAt = new Date().toISOString();
const result = spawnSync(wrangler, args, { encoding: "utf8", env: strippedEnv });
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const report = {
  schema: "sdt-g60-w152-mv/v1",
  task: "SDT-G60-AUTHORITY-B-RETRY-W152",
  serviceId,
  sourceCommit,
  config,
  wrangler,
  tokenEnvironment: Object.fromEntries(STRIPPED_NAMES.map((name) => [name, "UNSET"])),
  cohortEvents: events,
  command: { args, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal ?? null, spawnError: result.error?.message ?? null, sql, stdout, stderr },
  status: result.status === 0 ? "completed" : "failed",
};
report.parsed = (() => { try { return JSON.parse(stdout); } catch { return null; } })();
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (result.status !== 0) process.exitCode = result.status ?? 1;
else process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, resultSets: report.parsed?.length ?? null, rows: report.parsed?.[0]?.results?.length ?? null }) + "\n");

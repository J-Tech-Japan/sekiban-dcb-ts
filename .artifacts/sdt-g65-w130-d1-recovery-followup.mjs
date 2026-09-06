#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

function persist(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return { code: "non_json_response", raw }; }
}

function items(body) {
  if (typeof body?.itemsJson !== "string") return [];
  try { return JSON.parse(body.itemsJson); } catch { return []; }
}

const baseUrl = required("--base-url").replace(/\/$/, "");
const reservationId = required("--reservation-id");
const commitReceivedAtMs = Number(required("--commit-received-at-ms"));
const outputPath = resolve(required("--report"));
const boundMs = Number(arg("--bound-ms", "120000"));
const pollMs = Number(arg("--poll-ms", "2000"));
const startedAtMs = Date.now();
const report = {
  schema: "sdt-g65-w130-d1-recovery/v1",
  task: "SDT-G65-PR127-DEPLOYED-REPAIR-WAKE-130",
  baseUrl,
  reservationId,
  commitReceivedAtMs,
  restoredAtMs: startedAtMs,
  boundMs,
  pageSize: 1000,
  scans: [],
  status: "running",
};

async function scan() {
  const pages = [];
  let pageNumber = 1;
  let totalPages = 1;
  while (pageNumber <= totalPages) {
    const started = Date.now();
    let response;
    let rawBody = "";
    try {
      response = await fetch(`${baseUrl}/api/read/reservations?pageNumber=${pageNumber}&pageSize=1000&newestFirst=true`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      rawBody = await response.text();
      const body = parse(rawBody);
      const declaredTotal = Number(body?.totalPages);
      const totalCount = Number(body?.totalCount);
      totalPages = Math.max(totalPages, Number.isSafeInteger(declaredTotal) && declaredTotal > 0 ? declaredTotal : Math.max(1, Math.ceil(totalCount / 1000)));
      const pageItems = items(body);
      pages.push({
        pageNumber,
        status: response.status,
        startedAtMs: started,
        receivedAtMs: Date.now(),
        requestMs: Date.now() - started,
        cfRay: response.headers.get("cf-ray"),
        totalCount: Number.isSafeInteger(totalCount) ? totalCount : null,
        totalPages,
        itemCount: pageItems.length,
        containsReservation: pageItems.some((item) => item?.reservationId === reservationId),
        rawBody,
      });
    } catch (error) {
      pages.push({ pageNumber, status: null, startedAtMs: started, receivedAtMs: Date.now(), requestMs: Date.now() - started, transportError: String(error), rawBody });
      break;
    }
    pageNumber += 1;
  }
  return { pages, visible: pages.some((page) => page.containsReservation === true), observedAtMs: Date.now() };
}

try {
  persist(outputPath, report);
  while (Date.now() < commitReceivedAtMs + boundMs) {
    const scanResult = await scan();
    const observation = {
      observedAtMs: scanResult.observedAtMs,
      commitToObservationMs: scanResult.observedAtMs - commitReceivedAtMs,
      visible: scanResult.visible,
      pages: scanResult.pages,
    };
    report.scans.push(observation);
    persist(outputPath, report);
    if (scanResult.visible) break;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(pollMs, Math.max(1, commitReceivedAtMs + boundMs - Date.now()))));
  }
  const last = report.scans.at(-1);
  report.status = last?.visible ? "visible-after-restore" : "missing-at-bound";
  report.finishedAtMs = Date.now();
  report.firstVisibleAtMs = report.scans.find((scanResult) => scanResult.visible)?.observedAtMs ?? null;
  report.commitToFirstVisibleMs = report.firstVisibleAtMs === null ? null : report.firstVisibleAtMs - commitReceivedAtMs;
  persist(outputPath, report);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: outputPath, commitToFirstVisibleMs: report.commitToFirstVisibleMs })}\n`);
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  report.finishedAtMs = Date.now();
  persist(outputPath, report);
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
}

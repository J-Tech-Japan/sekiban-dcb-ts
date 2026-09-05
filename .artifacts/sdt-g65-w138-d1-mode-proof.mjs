#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(name) {
  const value = arg(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return { code: "non_json_response" }; }
}

function persist(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function request(baseUrl, method, path, body) {
  const startedAtMs = Date.now();
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const rawBody = await response.text();
    const receivedAtMs = Date.now();
    return {
      method, path, requestBody: body ?? null, status: response.status,
      startedAtMs, receivedAtMs, elapsedMs: receivedAtMs - startedAtMs,
      cfRay: response.headers.get("cf-ray"),
      globalAdmission: response.headers.get("x-sdt-global-admission"),
      body: parse(rawBody), rawBody,
    };
  } catch (error) {
    const receivedAtMs = Date.now();
    return {
      method, path, requestBody: body ?? null, status: null,
      startedAtMs, receivedAtMs, elapsedMs: receivedAtMs - startedAtMs,
      cfRay: null, globalAdmission: null, body: null, rawBody: "",
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function scan(baseUrl, reservationId) {
  const first = await request(baseUrl, "GET", "/api/read/reservations?pageNumber=1&pageSize=1000&newestFirst=true");
  const body = first.body ?? {};
  const itemsValue = typeof body.itemsJson === "string" ? parse(body.itemsJson) : body.items;
  const items = Array.isArray(itemsValue) ? itemsValue : [];
  const totalCount = Number.isSafeInteger(body.totalCount) ? body.totalCount : null;
  const totalPages = Math.max(1, Number.isSafeInteger(body.totalPages) ? body.totalPages : Math.ceil((totalCount ?? 0) / 1000));
  const pages = [{ ...first, itemCount: items.length, totalCount, totalPages, containsReservation: items.some((item) => item?.reservationId === reservationId) }];
  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const page = await request(baseUrl, "GET", `/api/read/reservations?pageNumber=${pageNumber}&pageSize=1000&newestFirst=true`);
    const pageBody = page.body ?? {};
    const pageValue = typeof pageBody.itemsJson === "string" ? parse(pageBody.itemsJson) : pageBody.items;
    const pageItems = Array.isArray(pageValue) ? pageValue : [];
    pages.push({ ...page, itemCount: pageItems.length, totalCount: pageBody.totalCount ?? null, totalPages: pageBody.totalPages ?? totalPages, containsReservation: pageItems.some((item) => item?.reservationId === reservationId) });
  }
  return { reservationId, pageCount: pages.length, totalCount, totalPages, found: pages.some((page) => page.containsReservation), pages };
}

const baseUrl = required("--base-url").replace(/\/$/, "");
const mode = required("--mode");
const output = resolve(required("--report"));
const existingReservationId = required("--existing-reservation-id");
const existingRoomId = required("--existing-room-id");
const suffix = required("--suffix");
const report = {
  schema: "sdt-g65-w138-d1-mode-proof/v1",
  task: "SDT-G65-PR127-DEPLOYED-ACCEPTANCE-REPAIR-WAKE-138",
  mode, baseUrl, existingReservationId, existingRoomId,
  contract: "Public command/read surface only; no conformance endpoint; every receipt persisted after each request.",
  status: "running", operations: [], scans: [],
};

async function run() {
  persist(output, report);
  const existing = await request(baseUrl, "POST", "/api/commands/cancel-reservation", { reservationId: existingReservationId });
  report.operations.push({ role: "existing-partition-commit", partition: `reservation:${existingReservationId}`, ...existing });
  persist(output, report);
  report.scans.push({ role: "existing-after-commit", ...(await scan(baseUrl, existingReservationId)) });
  persist(output, report);

  const newRoomId = `g65-w138-${mode}-new-${suffix}`;
  const fresh = await request(baseUrl, "POST", "/api/commands/create-room", { roomId: newRoomId, name: `SDT-G65 W138 ${mode}` });
  report.operations.push({ role: "new-partition-first-commit", partition: `room:${newRoomId}`, ...fresh });
  persist(output, report);
  report.scans.push({ role: "new-after-commit", ...(await scan(baseUrl, existingReservationId)) });
  report.summary = {
    existing: { status: existing.status, kind: existing.body?.kind ?? null, code: existing.body?.code ?? null, globalAdmission: existing.globalAdmission, responseMs: existing.elapsedMs },
    newPartition: { status: fresh.status, kind: fresh.body?.kind ?? null, code: fresh.body?.code ?? null, error: fresh.body?.error ?? null, globalAdmission: fresh.globalAdmission, responseMs: fresh.elapsedMs },
    newRoomId,
  };
  report.status = "completed";
  report.finishedAt = new Date().toISOString();
  persist(output, report);
  process.stdout.write(`${JSON.stringify({ status: report.status, mode, output, summary: report.summary })}\n`);
}

run().catch((error) => {
  report.status = "failed";
  report.failure = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  persist(output, report);
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
});

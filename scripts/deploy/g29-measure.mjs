#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function argument(name, fallback) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; }
function required(name, value) { if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`); return value; }
function integer(name, value, minimum) { const number = Number(value); if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} must be >= ${minimum}`); return number; }
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null; }
function distribution(values) { return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length === 0 ? null : Math.max(...values), samples: values.length }; }
async function request(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers); headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store", headers });
  const text = await response.text(); let body; try { body = text.length === 0 ? {} : JSON.parse(text); } catch { body = text; }
  return { response, body };
}
function listItems(body) { let items = body?.itemsJson ?? body?.items; if (typeof items === "string") items = JSON.parse(items); return Array.isArray(items) ? items : []; }
async function visible(baseUrl, reservationId, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    for (let pageNumber = 1; pageNumber <= 100 && performance.now() - started <= timeoutMs; pageNumber += 1) {
      const result = await request(baseUrl, `/api/read/reservations?pageNumber=${pageNumber}&pageSize=100&g29_probe=${crypto.randomUUID()}`);
      const items = listItems(result.body);
      if (result.response.status === 200 && items.some((item) => item?.reservationId === reservationId)) return { monotonic: performance.now(), observedAt: new Date().toISOString() };
      if (result.response.status !== 200 || items.length < 100) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reservation ${reservationId} did not become visible in the opted-in list view`);
}

export function summarizeMeasurements(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("G29 measurement sample set is empty");
  return {
    sampleCount: values.length,
    commandStartToResponseMs: distribution(values.map((value) => value.commandStartToResponseMs)),
    responseToVisibleMs: distribution(values.map((value) => value.responseToVisibleMs)),
    commandStartToVisibleMs: distribution(values.map((value) => value.commandStartToVisibleMs)),
    statusRaw: values.map((value) => ({
      index: value.index,
      roomId: value.roomId,
      reservationId: value.reservationId,
      commandStartAt: value.commandStartAt ?? value.commandStartedAt,
      responseAt: value.responseAt,
      visibleAt: value.visibleAt,
      ...(value.statusRaw ?? { status: value.status, kind: value.kind, fallback: value.fallback }),
    })),
    errorCount: values.filter((value) => value.status < 200 || value.status >= 300 || value.kind !== "committed").length,
    fallbackCount: values.filter((value) => value.fallback).length,
  };
}

export async function measure(baseUrl, samples, timeoutMs) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const roomId = `g29-room-${crypto.randomUUID().slice(0, 12)}`;
    const setup = await request(baseUrl, "/api/commands/create-room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId, name: "SDT-G29" }) });
    if (setup.response.status !== 200 || setup.body?.kind !== "committed") throw new Error(`create-room failed: ${JSON.stringify(setup.body)}`);
    const reservationId = `g29-reservation-${crypto.randomUUID().slice(0, 12)}`;
    const commandStartedAt = new Date().toISOString();
    const started = performance.now();
    const response = await request(baseUrl, "/api/commands/reserve-room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId, reservationId, userId: "SDT-G29" }) });
    const responded = performance.now();
    const responseAt = new Date().toISOString();
    if (response.response.status !== 200 || response.body?.kind !== "committed") throw new Error(`reserve-room failed: ${JSON.stringify(response.body)}`);
    const becameVisible = await visible(baseUrl, reservationId, timeoutMs);
    values.push({
      index,
      roomId,
      reservationId,
      commandStartAt: commandStartedAt,
      commandStartedAt,
      responseAt,
      visibleAt: becameVisible.observedAt,
      commandStartToResponseMs: responded - started,
      responseToVisibleMs: becameVisible.monotonic - responded,
      commandStartToVisibleMs: becameVisible.monotonic - started,
      status: response.response.status,
      kind: response.body?.kind,
      fallback: response.body?.fallback === true || response.body?.kind === "timeout",
      statusRaw: {
        httpStatus: response.response.status,
        kind: response.body?.kind ?? null,
        code: response.body?.code ?? null,
        fallback: response.body?.fallback === true || response.body?.kind === "timeout",
      },
    });
  }
  if (values.length !== samples) throw new Error(`G29 fixed-N omitted samples: expected ${samples}, observed ${values.length}`);
  const summary = summarizeMeasurements(values);
  if (summary.errorCount !== 0 || summary.fallbackCount !== 0) throw new Error("G29 fixed-N observed an error or fallback");
  if (summary.responseToVisibleMs.p50 === null || summary.responseToVisibleMs.p50 >= 1000) throw new Error(`G29 response-to-visible p50 is not sub-second: ${summary.responseToVisibleMs.p50}`);
  if (summary.commandStartToVisibleMs.p50 === null || summary.commandStartToVisibleMs.p50 < 1000) throw new Error(`G29 total command-start-to-visible p50 unexpectedly remains sub-second: ${summary.commandStartToVisibleMs.p50}`);
  return { ...summary, samples: values, interpretation: "response-to-visible is the measured visibility interval; command-start-to-response and command-start-to-visible include the POST and total is required to remain non-sub-second" };
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G29_BASE_URL));
  const tokenFile = required("--token-file", argument("--token-file", process.env.G29_CONFORMANCE_TOKEN_FILE));
  const token = readFileSync(tokenFile, "utf8").trim();
  const report = argument("--report", process.env.G29_REPORT ?? ".artifacts/g29-measurement.json");
  const samples = integer("--samples", argument("--samples", "10"), 10);
  const timeoutMs = integer("--timeout-ms", argument("--timeout-ms", "15000"), 1);
  const witness = await request(baseUrl, `/conformance/v1/g29-config?g29_measure=${crypto.randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
  if (witness.response.status !== 200 || witness.body?.task !== "SDT-G29" || witness.body?.viewCount !== 2 || JSON.stringify(witness.body?.allowedViews) !== JSON.stringify(["RoomProjector", "ReservationProjector"])) throw new Error(`G29 topology verification failed: HTTP ${witness.response.status}`);
  const evidence = { task: "SDT-G29", baseUrl, startedAt: new Date().toISOString(), topology: witness.body, latency: await measure(baseUrl, samples, timeoutMs), secrets: "redacted" };
  mkdirSync(dirname(report), { recursive: true }); writeFileSync(report, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"); console.log(JSON.stringify(evidence, null, 2));
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

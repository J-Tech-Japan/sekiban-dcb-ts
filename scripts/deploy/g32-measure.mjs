#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function integer(name, value, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be >= ${minimum}`);
  return parsed;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function distribution(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length === 0 ? null : Math.max(...values), samples: values.length };
}

async function request(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers, cache: "no-store" });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { response, body, raw };
}

function listItems(body) {
  let items = body?.itemsJson ?? body?.items;
  if (typeof items === "string") items = JSON.parse(items);
  return Array.isArray(items) ? items : [];
}

function committedSuid(body) {
  const response = body?.response && typeof body.response === "object" ? body.response : body;
  const event = Array.isArray(response?.writtenEvents) ? response.writtenEvents[0] : undefined;
  const value = event?.sortableUniqueIdValue;
  if (typeof value !== "string" || !/^[0-9]{30}$/.test(value)) throw new Error("G32 command did not return a 30-digit committed SUID");
  return value;
}

function listPath(suid) {
  return `/api/read/reservations?pageNumber=1&pageSize=20&newestFirst=true&waitForSortableUniqueId=${encodeURIComponent(suid)}`;
}

export function summarizeMeasurements(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("G32 fixed-N measurement is empty");
  return {
    sampleCount: samples.length,
    commandStartToResponseMs: distribution(samples.map((sample) => sample.commandStartToResponseMs)),
    responseToListRedrawMs: distribution(samples.map((sample) => sample.responseToListRedrawMs)),
    commandStartToListRedrawMs: distribution(samples.map((sample) => sample.commandStartToListRedrawMs)),
    statusRaw: samples.map((sample) => ({
      index: sample.index,
      roomId: sample.roomId,
      reservationId: sample.reservationId,
      commitSuid: sample.commitSuid,
      commandStartAt: sample.commandStartAt,
      responseAt: sample.responseAt,
      listRequestStartedAt: sample.listRequestStartedAt,
      listRenderedAt: sample.listRenderedAt,
      createStatus: sample.createStatus,
      commandStatus: sample.commandStatus,
      commandKind: sample.commandKind,
      listStatus: sample.listStatus,
      listCode: sample.listCode,
    })),
    errorCount: samples.filter((sample) => sample.createStatus !== 200 || sample.commandStatus !== 200 || sample.commandKind !== "committed" || sample.listStatus !== 200).length,
  };
}

export async function measure(baseUrl, token, samples) {
  const rows = [];
  let firstWrite = null;
  for (let index = 0; index < samples; index += 1) {
    const roomId = `g32-room-${crypto.randomUUID().slice(0, 12)}`;
    const createStartedAt = new Date().toISOString();
    const create = await request(baseUrl, "/api/commands/create-room", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId, name: "SDT-G32" }),
    });
    if (create.response.status !== 200 || create.body?.kind !== "committed") throw new Error(`G32 create-room failed: ${JSON.stringify(create.body)}`);
    if (firstWrite === null) firstWrite = { command: "create-room", roomId, at: createStartedAt, status: create.response.status };
    const reservationId = `g32-reservation-${crypto.randomUUID().slice(0, 12)}`;
    const commandStartAt = new Date().toISOString();
    const start = performance.now();
    const reserve = await request(baseUrl, "/api/commands/reserve-room", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId, reservationId, userId: "SDT-G32" }),
    });
    const responseAt = new Date().toISOString();
    const responded = performance.now();
    if (reserve.response.status !== 200 || reserve.body?.kind !== "committed") throw new Error(`G32 reserve-room failed: ${JSON.stringify(reserve.body)}`);
    const commitSuid = committedSuid(reserve.body);
    const listRequestStartedAt = new Date().toISOString();
    const list = await request(baseUrl, listPath(commitSuid), { headers: { accept: "application/json" } });
    const rendered = performance.now();
    const listRenderedAt = new Date().toISOString();
    if (list.response.status !== 200 || !listItems(list.body).some((item) => item?.reservationId === reservationId)) {
      throw new Error(`G32 reserve→one-list redraw failed: ${JSON.stringify({ status: list.response.status, body: list.body, reservationId })}`);
    }
    rows.push({
      index, roomId, reservationId, commitSuid, createStatus: create.response.status,
      commandStartAt, responseAt, listRequestStartedAt, listRenderedAt,
      commandStartToResponseMs: responded - start,
      responseToListRedrawMs: rendered - responded,
      commandStartToListRedrawMs: rendered - start,
      commandStatus: reserve.response.status, commandKind: reserve.body?.kind,
      listStatus: list.response.status, listCode: list.body?.code ?? null, listPath: listPath(commitSuid),
    });
  }
  const summary = summarizeMeasurements(rows);
  if (summary.errorCount !== 0 || rows.length !== samples || firstWrite === null) throw new Error("G32 fixed-N measurement did not complete cleanly");
  const oldSuid = "suid-00000000000000000001787414836102";
  const stale = await request(baseUrl, listPath(oldSuid), { headers: { accept: "application/json" } });
  if (stale.response.status !== 400) throw new Error(`G32 old 37-character SUID stale-negative expected 400, got ${stale.response.status}`);
  const config = await request(baseUrl, `/conformance/v1/g32-config?g32_measure=${crypto.randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
  const store = await request(baseUrl, `/conformance/v1/g32-store-state?g32_measure=${crypto.randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await request(baseUrl, `/api/sekiban/serialized?g32_measure=${crypto.randomUUID()}`);
  if (config.response.status !== 200 || store.response.status !== 200 || raw.response.status !== 404) throw new Error("G32 five-endpoint conformance setup failed");
  return {
    ...summary,
    samples: rows,
    firstNewWrite: firstWrite,
    staleNegatives: [{
      id: "old-37-character-suid-list", status: stale.response.status, code: stale.body?.code ?? null,
      outcome: "typed-rejected-before-list-dispatch", value: oldSuid,
    }],
    fiveEndpointConformance: [
      { endpoint: "/conformance/v1/g32-config", status: config.response.status },
      { endpoint: "/conformance/v1/g32-store-state", status: store.response.status },
      { endpoint: "/api/commands/create-room", status: rows[0].createStatus },
      { endpoint: "/api/commands/reserve-room", status: rows[0].commandStatus },
      { endpoint: "/api/read/reservations?waitForSortableUniqueId=<30-digit>", status: rows[0].listStatus },
    ],
    rawV1: { endpoint: "/api/sekiban/serialized", status: raw.response.status },
    finalStoreState: store.body,
    abortForwardFix: {
      abortAllowedThrough: "final-C deploy and post-witness before first new-store command",
      firstNewStoreWrite: firstWrite,
      afterFirstWrite: "forward-fix-only; this script never rolls back new bindings or recreates the old service",
    },
    interpretation: "Each sample records command response, exactly one server wait/list redraw, and total independently; no client poll/retry loop is included.",
  };
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G32_BASE_URL));
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G32_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) throw new Error("G32 conformance token is empty");
  const samples = integer("--samples", argument("--samples", "10"), 10);
  const evidence = {
    task: "SDT-G32", baseUrl, startedAt: new Date().toISOString(),
    latency: await measure(baseUrl, token, samples), secrets: "redacted",
  };
  const output = argument("--report", ".artifacts/g32-measurement.json");
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ samples: evidence.latency.sampleCount, p50: evidence.latency.responseToListRedrawMs.p50, p95: evidence.latency.responseToListRedrawMs.p95 }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

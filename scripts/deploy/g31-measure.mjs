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
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} must be >= ${minimum}`);
  return number;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function distribution(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length === 0 ? null : Math.max(...values), samples: values.length };
}

async function request(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store", headers });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { response, body };
}

function listItems(body) {
  let items = body?.itemsJson ?? body?.items;
  if (typeof items === "string") items = JSON.parse(items);
  return Array.isArray(items) ? items : [];
}

function committedSuid(body) {
  const response = body?.response && typeof body.response === "object" ? body.response : body;
  const first = Array.isArray(response?.writtenEvents) ? response.writtenEvents[0] : undefined;
  if (typeof first?.sortableUniqueIdValue !== "string" || first.sortableUniqueIdValue.length === 0) {
    throw new Error("G31 committed command omitted its sortableUniqueIdValue");
  }
  return first.sortableUniqueIdValue;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function readWaitState(baseUrl, token, suid) {
  const response = await request(baseUrl, `/conformance/v1/g31-wait-state?suid=${encodeURIComponent(suid)}&g31_gc=${crypto.randomUUID()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.response.status !== 200 || response.body?.task !== "SDT-G31") {
    throw new Error(`G31 wait-state witness failed: HTTP ${response.response.status}`);
  }
  return response.body;
}

async function waitForGc(baseUrl, token, suid, timeoutMs) {
  const started = performance.now();
  let last;
  while (performance.now() - started <= timeoutMs) {
    last = await readWaitState(baseUrl, token, suid);
    const target = last.target;
    const state = last.state;
    if (
      target?.kind === "stored" && target.suid === suid &&
      state?.targetReceipt === false &&
      typeof state.safeContiguousHead === "string" && byteCompare(state.safeContiguousHead, suid) >= 0
    ) {
      return { elapsedMs: performance.now() - started, state: last };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`G31 receipt GC did not converge for ${suid}: ${JSON.stringify(last)}`);
}

export function summarizeMeasurements(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("G31 measurement sample set is empty");
  return {
    sampleCount: values.length,
    commandStartToResponseMs: distribution(values.map((value) => value.commandStartToResponseMs)),
    responseToListRedrawMs: distribution(values.map((value) => value.responseToListRedrawMs)),
    commandStartToListRedrawMs: distribution(values.map((value) => value.commandStartToListRedrawMs)),
    statusRaw: values.map((value) => ({
      index: value.index,
      roomId: value.roomId,
      reservationId: value.reservationId,
      commitSuid: value.commitSuid,
      commandStartAt: value.commandStartAt,
      responseAt: value.responseAt,
      listRequestStartedAt: value.listRequestStartedAt,
      listRenderedAt: value.listRenderedAt,
      commandStatus: value.commandStatus,
      commandKind: value.commandKind,
      listStatus: value.listStatus,
      listCode: value.listCode,
    })),
    errorCount: values.filter((value) => value.commandStatus < 200 || value.commandStatus >= 300 || value.commandKind !== "committed" || value.listStatus !== 200).length,
  };
}

function g31ListPath(suid) {
  return `/api/read/reservations?pageNumber=1&pageSize=20&newestFirst=true&waitForSortableUniqueId=${encodeURIComponent(suid)}`;
}

export async function measure(baseUrl, samples, timeoutMs, token) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const roomId = `g31-room-${crypto.randomUUID().slice(0, 12)}`;
    const setup = await request(baseUrl, "/api/commands/create-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, name: "SDT-G31" }),
    });
    if (setup.response.status !== 200 || setup.body?.kind !== "committed") throw new Error(`G31 create-room failed: ${JSON.stringify(setup.body)}`);
    const reservationId = `g31-reservation-${crypto.randomUUID().slice(0, 12)}`;
    const commandStartAt = new Date().toISOString();
    const commandStarted = performance.now();
    const command = await request(baseUrl, "/api/commands/reserve-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, reservationId, userId: "SDT-G31" }),
    });
    const responded = performance.now();
    const responseAt = new Date().toISOString();
    if (command.response.status !== 200 || command.body?.kind !== "committed") throw new Error(`G31 reserve-room failed: ${JSON.stringify(command.body)}`);
    const commitSuid = committedSuid(command.body);
    // This is the exact browser follow-up: one list request carrying the
    // committed SUID. There is no client poll/retry loop in the measurement.
    const listRequestStartedAt = new Date().toISOString();
    const list = await request(baseUrl, g31ListPath(commitSuid), { headers: { Accept: "application/json" } });
    const rendered = performance.now();
    const listRenderedAt = new Date().toISOString();
    const items = listItems(list.body);
    if (list.response.status !== 200 || !items.some((item) => item?.reservationId === reservationId)) {
      throw new Error(`G31 server wait/list redraw failed: ${JSON.stringify({ status: list.response.status, body: list.body, reservationId })}`);
    }
    values.push({
      index,
      roomId,
      reservationId,
      commitSuid,
      commandStartAt,
      responseAt,
      listRequestStartedAt,
      listRenderedAt,
      commandStartToResponseMs: responded - commandStarted,
      responseToListRedrawMs: rendered - responded,
      commandStartToListRedrawMs: rendered - commandStarted,
      commandStatus: command.response.status,
      commandKind: command.body?.kind,
      listStatus: list.response.status,
      listCode: list.body?.code ?? null,
      listPath: g31ListPath(commitSuid),
    });
  }
  if (values.length !== samples) throw new Error(`G31 fixed-N omitted samples: expected ${samples}, observed ${values.length}`);
  const summary = summarizeMeasurements(values);
  if (summary.errorCount !== 0) throw new Error("G31 fixed-N observed a command or list failure");
  const oldest = values[0];
  const gc = await waitForGc(baseUrl, token, oldest.commitSuid, timeoutMs);
  const oldList = await request(baseUrl, g31ListPath(oldest.commitSuid), { headers: { Accept: "application/json" } });
  const oldItems = listItems(oldList.body);
  if (oldList.response.status !== 200 || !oldItems.some((item) => item?.reservationId === oldest.reservationId)) {
    throw new Error(`G31 GC old-SUID success probe failed: ${JSON.stringify({ status: oldList.response.status, body: oldList.body })}`);
  }
  return {
    ...summary,
    samples: values,
    oldSuidGcProbe: {
      reservationId: oldest.reservationId,
      suid: oldest.commitSuid,
      receiptGcElapsedMs: gc.elapsedMs,
      waitState: gc.state,
      listStatus: oldList.response.status,
      listCode: oldList.body?.code ?? null,
      listPath: g31ListPath(oldest.commitSuid),
      outcome: "source-target-plus-active-safe-head success after target receipt GC",
    },
    interpretation: "command-start→response, response→one server wait/list redraw, and total are recorded independently; no client polling or automatic retry is included",
  };
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G31_BASE_URL));
  const tokenFile = required("--token-file", argument("--token-file", process.env.G31_CONFORMANCE_TOKEN_FILE));
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length === 0) throw new Error("G31 conformance token file is empty");
  const report = argument("--report", process.env.G31_REPORT ?? ".artifacts/g31-measurement.json");
  const samples = integer("--samples", argument("--samples", "10"), 10);
  const timeoutMs = integer("--gc-timeout-ms", argument("--gc-timeout-ms", "120000"), 1);
  const config = await request(baseUrl, `/conformance/v1/g31-config?g31_measure=${crypto.randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
  if (
    config.response.status !== 200 || config.body?.task !== "SDT-G31" ||
    config.body?.waitFor?.sourceTarget !== "unique-indexed-point-read" ||
    config.body?.waitFor?.activeReceipt !== "generation-definition-bound" ||
    config.body?.waitFor?.safeHead !== "unique-source-required" ||
    config.body?.waitFor?.maxPointReads !== 252
  ) throw new Error(`G31 topology verification failed: HTTP ${config.response.status}`);
  const evidence = {
    task: "SDT-G31",
    baseUrl,
    startedAt: new Date().toISOString(),
    topology: config.body,
    latency: await measure(baseUrl, samples, timeoutMs, token),
    secrets: "redacted",
  };
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

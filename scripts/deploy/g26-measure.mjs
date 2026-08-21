#!/usr/bin/env node
/**
 * SDT-G26 fixed-N visibility harness.
 *
 * Run this once against each separately deployed ephemeral topology. It reports
 * command-start -> response, response -> visible, and command-start ->
 * visible separately. The harness never turns Miniflare timings into an SLO;
 * the caller records the deployment topology and controlled concurrency in the
 * resulting evidence document.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

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
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? null : Math.max(...values),
    samples: values.length,
  };
}

async function request(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store", headers });
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? {} : JSON.parse(text); } catch { /* keep text */ }
  return { response, body };
}

function listItems(body) {
  let items = body?.itemsJson ?? body?.items;
  if (typeof items === "string") items = JSON.parse(items);
  return Array.isArray(items) ? items : [];
}

async function readUntilListVisible(baseUrl, reservationId, timeoutMs) {
  const started = performance.now();
  const pageSize = 100;
  while (performance.now() - started <= timeoutMs) {
    for (let pageNumber = 1; pageNumber <= 100 && performance.now() - started <= timeoutMs; pageNumber += 1) {
      const { response, body } = await request(baseUrl, `/api/read/reservations?pageNumber=${pageNumber}&pageSize=${pageSize}&g26_probe=${crypto.randomUUID()}`);
      const items = listItems(body);
      if (response.status === 200 && items.some((item) => item?.reservationId === reservationId)) return performance.now();
      // A short page is the durable end of this list snapshot. Retry from
      // page one after the projection advances rather than assuming the new
      // row will sort into the first fixed-size page.
      if (response.status !== 200 || items.length < pageSize) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reservation ${reservationId} did not become visible in the opted-in list view within ${timeoutMs}ms`);
}

async function verifyTopology(baseUrl, token, expectedViewCount, expectedAllowedViews) {
  const { response, body } = await request(baseUrl, `/conformance/v1/g26-config?g26_probe=${crypto.randomUUID()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200 || body === null || typeof body !== "object") {
    throw new Error(`G26 topology conformance returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body.viewCount !== expectedViewCount) {
    throw new Error(`G26_VIEW_COUNT mismatch: expected ${expectedViewCount}, observed ${JSON.stringify(body.viewCount)}`);
  }
  const observedViews = Array.isArray(body.allowedViews) ? body.allowedViews : [];
  if (expectedAllowedViews.length > 0 && JSON.stringify(observedViews) !== JSON.stringify(expectedAllowedViews)) {
    throw new Error(`G26 allowed-view mismatch: expected ${JSON.stringify(expectedAllowedViews)}, observed ${JSON.stringify(observedViews)}`);
  }
  return body;
}

async function measureOne(baseUrl, sample, timeoutMs) {
  const roomId = `g26-${sample}-${crypto.randomUUID().slice(0, 12)}`;
  const setup = await request(baseUrl, "/api/commands/create-room", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ roomId, name: "SDT-G26" }),
  });
  if (setup.response.status !== 200 || setup.body?.kind !== "committed") {
    throw new Error(`create-room setup returned HTTP ${setup.response.status}: ${JSON.stringify(setup.body)}`);
  }
  // Room existence is read from the Tag state by reserve-room. Do not wait on
  // the scalar RoomProjector here: the G26 visibility oracle is the opted-in
  // reservation list view, including for the one-view topology.
  const reservationId = `g26-reservation-${sample}-${crypto.randomUUID().slice(0, 12)}`;
  const commandStarted = performance.now();
  const { response, body } = await request(baseUrl, "/api/commands/reserve-room", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ roomId, reservationId, userId: "SDT-G26" }),
  });
  const responded = performance.now();
  if (response.status !== 200 || body?.kind !== "committed") {
    throw new Error(`reserve-room returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  const visible = await readUntilListVisible(baseUrl, reservationId, timeoutMs);
  return {
    commandStartToResponseMs: responded - commandStarted,
    responseToVisibleMs: visible - responded,
    commandStartToVisibleMs: visible - commandStarted,
  };
}

async function runTopology(baseUrl, viewCount, configuration, samples, concurrency, timeoutMs) {
  const values = [];
  for (let offset = 0; offset < samples; offset += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, samples - offset) }, (_, index) =>
      measureOne(baseUrl, `${viewCount}-${offset + index}`, timeoutMs));
    values.push(...await Promise.all(batch));
  }
  return {
    viewCount,
    configuration,
    sampleCount: values.length,
    controlledConcurrency: concurrency,
    commandStartToResponseMs: distribution(values.map((value) => value.commandStartToResponseMs)),
    responseToVisibleMs: distribution(values.map((value) => value.responseToVisibleMs)),
    commandStartToVisibleMs: distribution(values.map((value) => value.commandStartToVisibleMs)),
  };
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G26_BASE_URL));
  const serviceId = required("G26_SERVICE_ID", process.env.G26_SERVICE_ID);
  const conformanceToken = required("G26_CONFORMANCE_TOKEN", argument("--conformance-token", process.env.G26_CONFORMANCE_TOKEN));
  const report = argument("--report", process.env.G26_REPORT ?? ".artifacts/g26-remote-measurement.json");
  const samples = integer("--samples", argument("--samples", "20"), 20);
  const concurrency = integer("--concurrency", argument("--concurrency", "1"), 1);
  const timeoutMs = integer("--timeout-ms", argument("--timeout-ms", "15000"), 1);
  const expectedViewCount = integer("--expected-view-count", required("--expected-view-count", argument("--expected-view-count", process.env.G26_EXPECTED_VIEW_COUNT)), 1);
  const expectedAllowedViews = (argument("--expected-allowed-views", process.env.G26_EXPECTED_ALLOWED_VIEWS ?? "") ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const startedAt = new Date().toISOString();
  const configuration = await verifyTopology(baseUrl, conformanceToken, expectedViewCount, expectedAllowedViews);
  const topology = await runTopology(baseUrl, expectedViewCount, configuration, samples, concurrency, timeoutMs);
  const evidence = {
    task: "SDT-G26",
    label: "remote ephemeral fixed-N fan-out measurement",
    baseUrl,
    serviceId,
    startedAt,
    completedAt: new Date().toISOString(),
    samples,
    concurrency,
    topology: [topology],
    receiverMetrics: {
      source: process.env.G26_RECEIVER_METRICS_SOURCE ?? "not-supplied",
      doorbellCoreMs: null,
      perViewApplyMs: null,
      pipelineD1Errors: null,
      pipelineD1Overloaded: null,
      mvD1Errors: null,
      mvD1Overloaded: null,
      fastSuccessCount: null,
      queueFallbackCount: null,
      cronFallbackCount: null,
    },
    visibilityOracle: "opted-in list view /api/read/reservations, not scalar room projection",
    interpretation: "response-to-visible is the G26 fast-path claim; command-start-to-visible includes the G27-scope POST and is not claimed sub-second",
    secrets: "redacted",
  };
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

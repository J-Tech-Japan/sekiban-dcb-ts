#!/usr/bin/env node
/**
 * SDT-G26 fixed-N visibility harness.
 *
 * Run this against each ephemeral 1/5/10-view deployment. It reports
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
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? {} : JSON.parse(text); } catch { /* keep text */ }
  return { response, body };
}

async function readUntilVisible(baseUrl, roomId, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    const { response, body } = await request(baseUrl, `/api/read/room?roomId=${encodeURIComponent(roomId)}`);
    if (response.status === 200 && body && typeof body === "object" && body.state?.status === "created") {
      return performance.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`room ${roomId} did not become visible within ${timeoutMs}ms`);
}

async function measureOne(baseUrl, sample, timeoutMs) {
  const roomId = `g26-${sample}-${crypto.randomUUID().slice(0, 12)}`;
  const commandStarted = performance.now();
  const { response, body } = await request(baseUrl, "/api/commands/create-room", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ roomId, name: "SDT-G26" }),
  });
  const responded = performance.now();
  if (response.status !== 200 || body?.kind !== "committed") {
    throw new Error(`create-room returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  const visible = await readUntilVisible(baseUrl, roomId, timeoutMs);
  return {
    commandStartToResponseMs: responded - commandStarted,
    responseToVisibleMs: visible - responded,
    commandStartToVisibleMs: visible - commandStarted,
  };
}

async function runTopology(baseUrl, viewCount, samples, concurrency, timeoutMs) {
  const values = [];
  for (let offset = 0; offset < samples; offset += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, samples - offset) }, (_, index) =>
      measureOne(baseUrl, `${viewCount}-${offset + index}`, timeoutMs));
    values.push(...await Promise.all(batch));
  }
  return {
    viewCount,
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
  const report = argument("--report", process.env.G26_REPORT ?? ".artifacts/g26-remote-measurement.json");
  const samples = integer("--samples", argument("--samples", "20"), 20);
  const concurrency = integer("--concurrency", argument("--concurrency", "1"), 1);
  const timeoutMs = integer("--timeout-ms", argument("--timeout-ms", "15000"), 1);
  const viewCounts = (argument("--view-counts", "1,5,10") ?? "1,5,10")
    .split(",").map((value) => integer("view count", value, 1));
  const startedAt = new Date().toISOString();
  const topologies = [];
  for (const viewCount of viewCounts) {
    topologies.push(await runTopology(baseUrl, viewCount, samples, concurrency, timeoutMs));
  }
  const evidence = {
    task: "SDT-G26",
    label: "remote ephemeral fixed-N fan-out measurement",
    baseUrl,
    serviceId,
    startedAt,
    completedAt: new Date().toISOString(),
    samples,
    concurrency,
    topology: topologies,
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

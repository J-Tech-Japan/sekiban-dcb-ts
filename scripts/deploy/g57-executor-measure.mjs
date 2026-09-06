#!/usr/bin/env node
/**
 * SDT-G57 AC5 deployed comparison.
 *
 * The two windows use the same public create-room command shape.  The only
 * variable is the executor option: read-through leaves the room claim
 * uncovered, while snapshot-only supplies the portable empty snapshot.  A
 * receipt is flushed after setup and after every accepted request so an
 * interrupted window remains useful evidence.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { summary, telemetryForLedger } from "./g37-sample.mjs";

const MODES = Object.freeze(["read-through", "snapshot-only"]);
const DEFAULT_SAMPLE_COUNT = 50;
const MAX_SAMPLE_COUNT = 100;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer in 1..${maximum}`);
  return parsed;
}

function nonNegativeInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function sourceCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("--source-commit must be a 40-character lowercase SHA");
  return value;
}

function runId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) throw new Error("--run-id must be 8..64 URL-safe characters");
  return value;
}

function headers(response) {
  return Object.fromEntries([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function request(baseUrl, path, init) {
  const startedAtMs = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store" });
  const completedAtMs = Date.now();
  const rawBody = await response.text();
  let body;
  try {
    body = rawBody.length === 0 ? {} : JSON.parse(rawBody);
  } catch {
    body = { rawBody };
  }
  return Object.freeze({
    startedAtMs,
    completedAtMs,
    elapsedMs: completedAtMs - startedAtMs,
    status: response.status,
    headers: headers(response),
    rawBody,
    body,
  });
}

function emptyRoomSnapshot(roomId) {
  return {
    projectorId: "RoomProjector",
    tag: `room:${roomId}`,
    head: null,
    exists: false,
    state: { status: "empty", version: 0, roomId: null, name: "" },
  };
}

function commandBody(mode, roomId, name) {
  return {
    input: { roomId, name },
    executor: mode === "snapshot-only"
      ? { readMode: mode, snapshots: [emptyRoomSnapshot(roomId)] }
      : { readMode: mode, snapshots: [] },
  };
}

function committedSuid(receipt, roomId) {
  const body = receipt.body;
  const responseBody = body?.response && typeof body.response === "object" ? body.response : body;
  const events = Array.isArray(body?.writtenEvents)
    ? body.writtenEvents
    : Array.isArray(responseBody?.writtenEvents) ? responseBody.writtenEvents : [];
  const event = events.at(-1);
  if (receipt.status !== 200 || body?.kind !== "committed" || typeof event?.sortableUniqueIdValue !== "string") {
    const error = new Error(`G57 ${roomId} was not an accepted commit (HTTP ${receipt.status})`);
    error.evidence = { status: receipt.status, body, rawBody: receipt.rawBody };
    throw error;
  }
  return event.sortableUniqueIdValue;
}

function modeState(mode, count) {
  return {
    mode,
    expectedTagStateReadsPerCommit: mode === "snapshot-only" ? 0 : 1,
    expectedTagStateReadsSavedPerCommit: mode === "snapshot-only" ? 1 : 0,
    sampleCount: count,
    warmup: null,
    ledger: [],
    client: null,
    telemetry: null,
  };
}

function flush(output, state) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function waitForResponseSpacing(previousCompletedAtMs, minimumInterSampleMs) {
  const remainingMs = minimumInterSampleMs - (Date.now() - previousCompletedAtMs);
  if (remainingMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remainingMs));
}

async function captureMode({ baseUrl, mode, sampleCount, runIdValue, output, state, rootState, task, minimumInterSampleMs, coldFirst }) {
  let previousCompletedAtMs = null;
  if (coldFirst) {
    state.warmup = null;
    flush(output, rootState);
  } else {
    const warmupRoomId = `${task.toLowerCase()}-${mode}-warmup-${runIdValue.slice(0, 20)}`;
    const warmupName = `${task} ${mode} warmup`;
    const warmupStartedAtMs = Date.now();
    const warmup = await request(baseUrl, "/api/commands/create-room", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `${task}-${mode}/1.0` },
      body: JSON.stringify(commandBody(mode, warmupRoomId, warmupName)),
    });
    const warmupSuid = committedSuid(warmup, warmupRoomId);
    state.warmup = Object.freeze({
      phase: "discarded-warmup",
      roomId: warmupRoomId,
      suid: warmupSuid,
      ...warmup,
      startedAtMs: warmupStartedAtMs,
    });
    previousCompletedAtMs = warmup.completedAtMs;
    flush(output, rootState);
  }

  for (let ordinal = 1; ordinal <= sampleCount; ordinal += 1) {
    const roomId = `${task.toLowerCase()}-${mode}-${runIdValue.slice(0, 20)}-${String(ordinal).padStart(3, "0")}`;
    if (ordinal > 1 && previousCompletedAtMs !== null) await waitForResponseSpacing(previousCompletedAtMs, minimumInterSampleMs);
    const startedAtMs = Date.now();
    const receipt = await request(baseUrl, "/api/commands/create-room", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `${task}-${mode}/1.0` },
      body: JSON.stringify(commandBody(mode, roomId, `${task} ${mode} ${ordinal}`)),
    });
    const suid = committedSuid(receipt, roomId);
    state.ledger.push(Object.freeze({
      ordinal,
      phase: "sample",
      mode,
      roomId,
      suid,
      command: {
        method: "POST",
        path: "/api/commands/create-room",
        body: commandBody(mode, roomId, `${task} ${mode} ${ordinal}`),
      },
      startedAtMs,
      ...receipt,
      clientLatencyMs: receipt.completedAtMs - startedAtMs,
    }));
    previousCompletedAtMs = receipt.completedAtMs;
    state.client = summary(state.ledger.map((entry) => entry.clientLatencyMs));
    flush(output, rootState);
  }
  state.client = summary(state.ledger.map((entry) => entry.clientLatencyMs));
  return state;
}

async function captureTelemetryIfConfigured({ state, accountId, serviceId, versionId, sourceCommitValue, observabilityTokenFile, queryTemplatePath }) {
  if (typeof observabilityTokenFile !== "string" || observabilityTokenFile.length === 0) {
    state.telemetry = { status: "not-requested", reason: "G50_OBSERVABILITY_TOKEN_FILE path was not supplied" };
    return;
  }
  if (!existsSync(observabilityTokenFile)) {
    state.telemetry = { status: "unavailable", reason: "G50_OBSERVABILITY_TOKEN_FILE path was not found" };
    return;
  }
  const observabilityToken = readFileSync(observabilityTokenFile, "utf8").trim();
  if (observabilityToken.length === 0) {
    state.telemetry = { status: "unavailable", reason: "G50_OBSERVABILITY_TOKEN_FILE was empty" };
    return;
  }
  const queryTemplate = JSON.parse(readFileSync(queryTemplatePath, "utf8"));
  state.telemetry = await telemetryForLedger({
    accountId,
    observabilityToken,
    observabilityTokenReason: "G50_OBSERVABILITY_TOKEN_FILE path",
    serviceId,
    versionId,
    sourceCommit: sourceCommitValue,
    template: queryTemplate,
    ledger: state.ledger,
    required: false,
    retainTelemetry: true,
  });
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G57_BASE_URL));
  const sourceCommitValue = sourceCommit(required("--source-commit", argument("--source-commit", process.env.G57_SOURCE_COMMIT)));
  const versionId = required("--version-id", argument("--version-id", process.env.G57_VERSION_ID));
  const serviceId = required("--service-id", argument("--service-id", process.env.SDT_SERVICE_ID));
  const accountId = argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID);
  const sampleCount = positiveInteger("--samples", argument("--samples", String(DEFAULT_SAMPLE_COUNT)), MAX_SAMPLE_COUNT);
  const minimumInterSampleMs = nonNegativeInteger("--min-inter-sample-ms", argument("--min-inter-sample-ms", "0"));
  const coldFirst = process.argv.includes("--cold-first");
  const output = resolve(argument("--output", ".artifacts/sdt-g57-w126-g50-executor-comparison.json"));
  const runIdValue = runId(argument("--run-id", randomUUID().replaceAll("-", "")));
  const task = "SDT-G57";
  const observabilityTokenFile = argument("--observability-token-file", process.env.G50_OBSERVABILITY_TOKEN_FILE);
  const queryTemplatePath = resolve(argument("--query-template", "scripts/deploy/g37-observability-query.json"));
  const state = {
    schema: "sdt-g57-executor-g50-comparison/v1",
    task,
    runId: runIdValue,
    capturedAt: new Date().toISOString(),
    deployed: { baseUrl, serviceId, versionId, sourceCommit: sourceCommitValue },
    protocol: {
      publicSurface: "POST /api/commands/create-room",
      modes: MODES,
      sameCommandShape: true,
      sampleCountPerMode: sampleCount,
      discardedWarmupPerMode: coldFirst ? 0 : 1,
      coldFirstSampleIncluded: true,
      coldFirst,
      minimumInterSampleMs,
      pacingDefinition: "each sample starts at least minimumInterSampleMs after the preceding sample response",
      rawReceiptPersistence: "flush after warmup and every accepted sample",
      expectedReadAccounting: "read-through create-room reads one RoomProjector tag state; snapshot-only supplies the portable empty snapshot and reads zero tag state",
    },
    modes: [],
    errors: [],
  };
  flush(output, state);
  for (const mode of MODES) {
    const modeStateValue = modeState(mode, sampleCount);
    state.modes.push(modeStateValue);
    flush(output, state);
    await captureMode({ baseUrl, mode, sampleCount, runIdValue, output, state: modeStateValue, rootState: state, task, minimumInterSampleMs, coldFirst });
    if (typeof accountId === "string" && accountId.length > 0) {
      await captureTelemetryIfConfigured({
        state: modeStateValue,
        accountId,
        serviceId,
        versionId,
        sourceCommitValue,
        observabilityTokenFile,
        queryTemplatePath,
      });
      flush(output, state);
    }
  }
  state.comparison = {
    readThrough: state.modes[0]?.client,
    snapshotOnly: state.modes[1]?.client,
    p50SavedMs: (state.modes[0]?.client?.p50 ?? 0) - (state.modes[1]?.client?.p50 ?? 0),
    p95SavedMs: (state.modes[0]?.client?.p95 ?? 0) - (state.modes[1]?.client?.p95 ?? 0),
    expectedTagStateReadsSavedPerCommit: 1,
  };
  flush(output, state);
  process.stdout.write(`${JSON.stringify({ output, deployed: state.deployed, comparison: state.comparison }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), evidence: error?.evidence ?? null })}\n`);
  process.exitCode = 1;
});

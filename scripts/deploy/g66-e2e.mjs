#!/usr/bin/env node
/**
 * SDT-G66 public-surface deployed witness.
 *
 * One run is one browser-equivalent session: create a room, reserve it seven
 * times, reserve it once with a read-through executor, and cancel one
 * reservation.  The first command for each tag uses read-through; later
 * commands use a portable snapshot.  Every accepted command is checkpointed
 * before any visibility polling so a bound miss remains usable evidence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const UNSAFE_BOUND_MS = 5_000;
export const SAFE_BOUND_MS = 180_000;
export const DEFAULT_SAMPLE_COUNT = 10;
export const DEFAULT_PACE_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
const SUID = /^\d{30}$/;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
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

function runId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) throw new Error("--run-id must be 8..64 URL-safe characters");
  return value;
}

function compareSuid(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return -1;
  return left.localeCompare(right);
}

function atLeast(actual, expected) {
  return SUID.test(actual ?? "") && SUID.test(expected ?? "") && compareSuid(actual, expected) >= 0;
}

function nearestRank(values, percentile) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered.length === 0 ? null : ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function writeReceipt(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bodyObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function committedEvent(body) {
  const outer = bodyObject(body);
  const inner = bodyObject(outer.response);
  const events = Array.isArray(inner.writtenEvents) ? inner.writtenEvents
    : Array.isArray(outer.writtenEvents) ? outer.writtenEvents : [];
  const event = events.at(-1);
  return event !== undefined && typeof event.sortableUniqueIdValue === "string"
    ? event
    : null;
}

function admissionHeader(headers) {
  const value = headers.get("x-sdt-global-admission");
  return value === "admitted" || value === "not-admitted" || value === "unknown" ? value : "unknown";
}

async function requestJson(baseUrl, path, init = {}) {
  const startedAtMs = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const completedAtMs = Date.now();
  const rawBody = await response.text();
  let body;
  try { body = rawBody.length === 0 ? {} : JSON.parse(rawBody); } catch { body = { rawBody }; }
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
    body,
    rawBody,
    startedAtMs,
    completedAtMs,
    elapsedMs: completedAtMs - startedAtMs,
  };
}

function publicHeaders() {
  return { "content-type": "application/json", accept: "application/json", "user-agent": "SDT-G66-e2e/1.0" };
}

function conformanceHeaders(token) {
  return { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "SDT-G66-e2e-conformance/1.0" };
}

function projectionPath(kind, id) {
  return kind === "room" ? `/api/read/room?roomId=${encodeURIComponent(id)}` : `/api/read/reservation?reservationId=${encodeURIComponent(id)}`;
}

// The projection endpoint is the unsafe/tag-state witness.  The application
// query endpoints are a separate safe-lane witness and must be captured too;
// a safe MV head alone is not proof that the public query returned the event.
function safeQueryPath(kind, id) {
  return kind === "room"
    ? `/api/read/room-query?roomId=${encodeURIComponent(id)}`
    : "/api/read/reservations?pageNumber=1&pageSize=100&newestFirst=true";
}

function projectionTag(kind, id) {
  return kind === "room" ? `room:${id}` : `reservation:${id}`;
}

function projectorId(kind) {
  return kind === "room" ? "RoomProjector" : "ReservationProjector";
}

function projectionSnapshot(kind, id, result) {
  const body = bodyObject(result.body);
  const head = typeof body.lastSortedUniqueId === "string" && SUID.test(body.lastSortedUniqueId)
    ? body.lastSortedUniqueId : null;
  if (result.status !== 200 || head === null || !("state" in body)) return null;
  return {
    projectorId: projectorId(kind),
    tag: projectionTag(kind, id),
    head,
    exists: body.version !== 0,
    state: body.state,
  };
}

function emptySnapshot(kind, id) {
  return kind === "room"
    ? {
      projectorId: "RoomProjector",
      tag: projectionTag(kind, id),
      head: null,
      exists: false,
      state: { status: "empty", version: 0, roomId: null, name: "" },
    }
    : {
      projectorId: "ReservationProjector",
      tag: projectionTag(kind, id),
      head: null,
      exists: false,
      state: { status: "empty", version: 0, reservationId: null, roomId: null },
    };
}

async function waitForSnapshot(options, kind, id, deadlineMs) {
  const observations = [];
  for (;;) {
    const result = await requestJson(options.baseUrl, projectionPath(kind, id), { headers: publicHeaders() });
    observations.push({ status: result.status, elapsedMs: result.elapsedMs, completedAtMs: result.completedAtMs, body: result.body });
    const snapshot = projectionSnapshot(kind, id, result);
    if (snapshot !== null) return { snapshot, observations };
    if (Date.now() >= deadlineMs) return { snapshot: null, observations };
    await sleep(Math.min(options.pollMs, Math.max(1, deadlineMs - Date.now())));
  }
}

function healthSummary(result) {
  const body = bodyObject(result.body);
  const views = Array.isArray(body.materializedViews) ? body.materializedViews : [];
  const coverage = body.coverage !== null && typeof body.coverage === "object" ? body.coverage : {};
  const lag = body.lag !== null && typeof body.lag === "object" ? body.lag : {};
  const passRows = Array.isArray(body.safeLanePasses) ? body.safeLanePasses : [];
  const coverageHistory = Array.isArray(body.coverageHistory) ? body.coverageHistory : [];
  const liveProjections = Array.isArray(body.liveProjections) ? body.liveProjections : [];
  const latest = (values) => values.length === 0 ? [] : [values.at(-1)];
  return {
    receivedAtMs: result.completedAtMs,
    responseMs: result.elapsedMs,
    status: result.status,
    coverage: {
      kind: typeof coverage.kind === "string" ? coverage.kind : "unknown",
      reason: coverage.reason == null ? null : String(coverage.reason),
      partitionTag: coverage.partitionTag == null ? null : String(coverage.partitionTag),
      frontierSuid: typeof coverage.frontierSuid === "string" ? coverage.frontierSuid : null,
      observedAt: Number.isSafeInteger(coverage.observedAt) ? coverage.observedAt : null,
    },
    coverageHistory: latest(coverageHistory),
    coverageHistoryCount: coverageHistory.length,
    safeLanePasses: latest(passRows),
    safeLanePassCount: passRows.length,
    lag: {
      estimateMs: Number.isFinite(lag.estimateMs) ? lag.estimateMs : null,
      observedAt: Number.isSafeInteger(lag.observedAt) ? lag.observedAt : null,
      decayedMs: Number.isFinite(lag.decayedMs) ? lag.decayedMs : null,
      safeWindowMs: Number.isFinite(lag.safeWindowMs) ? lag.safeWindowMs : null,
      ceilingExceeded: lag.ceilingExceeded === true,
    },
    materializedViews: views.map((view) => ({
      viewId: typeof view?.viewId === "string" ? view.viewId : "",
      generation: Number.isSafeInteger(view?.generation) ? view.generation : null,
      safeHead: typeof view?.safeHead === "string" ? view.safeHead : "",
      safeHeadAgeMs: Number.isFinite(view?.safeHeadAgeMs) ? view.safeHeadAgeMs : null,
      unsafeRows: Number.isSafeInteger(view?.unsafeRows) ? view.unsafeRows : null,
      unsafeReceipts: Number.isSafeInteger(view?.unsafeReceipts) ? view.unsafeReceipts : null,
    })),
    liveProjections,
    globalHead: typeof body.globalHead === "string" ? body.globalHead : "",
  };
}

async function health(options) {
  const result = await requestJson(options.baseUrl, "/conformance/v1/read-health", { headers: conformanceHeaders(options.token) });
  if (result.status !== 200) throw new Error(`G66 read-health failed HTTP ${result.status}`);
  return healthSummary(result);
}

function parseJsonField(body, key, fallback) {
  const value = bodyObject(body)[key];
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function readHeadFromBody(body) {
  const value = bodyObject(body).readHead;
  return typeof value === "string" && SUID.test(value) ? value : null;
}

function queryObservation(result) {
  const body = bodyObject(result.body);
  return {
    status: result.status,
    responseMs: result.elapsedMs,
    completedAtMs: result.completedAtMs,
    body,
    readHead: readHeadFromBody(body),
    result: parseJsonField(body, "resultJson", null),
    rows: parseJsonField(body, "itemsJson", null),
  };
}

async function tagState(options, tag, projector, expectedVersion, expectedSuid) {
  const tagStateId = `${tag}:${projector}`;
  const result = await requestJson(options.baseUrl, "/conformance/v1/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: { ...conformanceHeaders(options.token), "content-type": "application/json" },
    body: JSON.stringify({ tagStateId }),
  });
  return {
    tagStateId,
    tag,
    projector,
    expectedVersion,
    expectedSuid,
    status: result.status,
    responseMs: result.elapsedMs,
    completedAtMs: result.completedAtMs,
    body: result.body,
    lastSortedUniqueId: typeof result.body?.lastSortedUniqueId === "string" ? result.body.lastSortedUniqueId : null,
    version: Number.isSafeInteger(result.body?.version) ? result.body.version : null,
  };
}

async function queryReads(options, roomId) {
  const room = await requestJson(options.baseUrl, `/api/read/room-query?roomId=${encodeURIComponent(roomId)}`, { headers: publicHeaders() });
  const reservations = await requestJson(options.baseUrl, "/api/read/reservations?pageNumber=1&pageSize=100&newestFirst=true", { headers: publicHeaders() });
  return {
    room: queryObservation(room),
    reservations: queryObservation(reservations),
  };
}

function safeHeadFor(healthValue, projector) {
  return healthValue.materializedViews.find((view) => view.viewId === projector)?.safeHead ?? "";
}

function commandInput(commandId, ids, ordinal) {
  if (commandId === "create-room") return { roomId: ids.roomId, name: `SDT-G66 ${ids.phase} ${ordinal}` };
  if (commandId === "reserve-room") return { roomId: ids.roomId, reservationId: ids.reservationId, userId: `g66-user-${ordinal}` };
  if (commandId === "cancel-reservation") return { reservationId: ids.reservationId };
  throw new Error(`unsupported G66 command ${commandId}`);
}

function targetFor(commandId, ids) {
  return commandId === "create-room"
    ? { kind: "room", id: ids.roomId, projector: "RoomProjector", expectedStatus: "created" }
    : { kind: "reservation", id: ids.reservationId, projector: "ReservationProjector", expectedStatus: commandId === "cancel-reservation" ? "cancelled" : "reserved" };
}

function affectedTagReads(sample) {
  const body = bodyObject(sample.commit.body);
  const response = bodyObject(body.response);
  const events = Array.isArray(response.writtenEvents) ? response.writtenEvents : Array.isArray(body.writtenEvents) ? body.writtenEvents : [];
  const versions = Array.isArray(response.tagWriteResults) ? response.tagWriteResults : Array.isArray(body.tagWriteResults) ? body.tagWriteResults : [];
  const versionByTag = new Map(versions.map((entry) => [entry?.tag, entry?.version]));
  const values = [];
  for (const event of events) {
    const suid = typeof event?.sortableUniqueIdValue === "string" ? event.sortableUniqueIdValue : sample.commit.suid;
    for (const tag of Array.isArray(event?.tags) ? event.tags : []) {
      if (typeof tag !== "string") continue;
      const separator = tag.indexOf(":");
      const kind = separator < 0 ? "unknown" : tag.slice(0, separator);
      const projector = kind === "room" ? "RoomProjector" : kind === "reservation" ? "ReservationProjector" : "";
      if (projector.length === 0) continue;
      values.push({ tag, projector, expectedVersion: versionByTag.get(tag) ?? null, expectedSuid: suid });
    }
  }
  return values;
}

function queryShowsTarget(target, queryReads) {
  if (target.kind === "room") {
    const result = queryReads?.room?.result;
    return queryReads?.room?.status === 200 && result !== null && typeof result === "object" && Number(result.count) >= 1;
  }
  const rows = Array.isArray(queryReads?.reservations?.rows) ? queryReads.reservations.rows : [];
  return queryReads?.reservations?.status === 200
    && typeof queryReads.reservations.readHead === "string"
    && rows.filter((row) => row?.reservationId === target.id).length === 1
    && rows.some((row) => row?.reservationId === target.id && row?.status === target.expectedStatus);
}

async function publicSafeQuery(options, target) {
  const result = await requestJson(options.baseUrl, safeQueryPath(target.kind, target.id), { headers: publicHeaders() });
  return queryObservation(result);
}

async function sendCommand(options, commandId, input, executor) {
  const result = await requestJson(options.baseUrl, `/api/commands/${commandId}`, {
    method: "POST",
    headers: publicHeaders(),
    body: JSON.stringify({ input, executor }),
  });
  const event = committedEvent(result.body);
  const body = bodyObject(result.body);
  return {
    commandId,
    input,
    executor,
    status: result.status,
    kind: typeof body.kind === "string" ? body.kind : null,
    code: typeof body.code === "string" ? body.code : null,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
    responseMs: result.elapsedMs,
    admission: admissionHeader(new Headers(result.headers)),
    headers: result.headers,
    body: result.body,
    rawBody: result.rawBody,
    suid: typeof event?.sortableUniqueIdValue === "string" ? event.sortableUniqueIdValue : null,
    eventId: typeof event?.eventId === "string" ? event.eventId : null,
  };
}

async function unsafeProbe(options, target, sample) {
  const responseCompletedAtMs = sample.commit.completedAtMs;
  const observations = [];
  const deadlineMs = responseCompletedAtMs + UNSAFE_BOUND_MS;
  for (;;) {
    const result = await requestJson(options.baseUrl, projectionPath(target.kind, target.id), { headers: publicHeaders() });
    const body = bodyObject(result.body);
    const visible = result.status === 200 && atLeast(body.lastSortedUniqueId, sample.commit.suid);
    observations.push({
      completedAtMs: result.completedAtMs,
      responseRelativeMs: result.completedAtMs - responseCompletedAtMs,
      elapsedMs: result.completedAtMs - responseCompletedAtMs,
      status: result.status,
      visible,
      lastSortedUniqueId: typeof body.lastSortedUniqueId === "string" ? body.lastSortedUniqueId : null,
      body,
    });
    if (visible) {
      const withinBound = result.completedAtMs <= deadlineMs;
      return { disposition: withinBound ? "pass" : "censored", boundMs: UNSAFE_BOUND_MS, firstVisibleAtMs: withinBound ? result.completedAtMs : null, responseRelativeMs: withinBound ? result.completedAtMs - responseCompletedAtMs : null, boundExceededAtMs: withinBound ? null : result.completedAtMs, observations };
    }
    if (Date.now() >= deadlineMs) {
      return { disposition: "censored", boundMs: UNSAFE_BOUND_MS, firstVisibleAtMs: null, responseRelativeMs: null, boundExceededAtMs: result.completedAtMs, observations };
    }
    await sleep(Math.min(options.pollMs, Math.max(1, deadlineMs - Date.now())));
  }
}

async function safeProbe(options, target, sample, report) {
  const responseCompletedAtMs = sample.commit.completedAtMs;
  const deadlineMs = responseCompletedAtMs + SAFE_BOUND_MS;
  for (;;) {
    const current = await health(options);
    report.healthSnapshots.push(current);
    sample.healthSnapshots.push(current);
    const safeHead = safeHeadFor(current, target.projector);
    const safeQuery = await publicSafeQuery(options, target);
    const publicQueryVisible = safeQuery.status === 200 && queryShowsTarget(target, { [target.kind === "room" ? "room" : "reservations"]: safeQuery });
    const readHeadAvailable = target.kind === "room" || safeQuery.readHead !== null;
    if (atLeast(safeHead, sample.commit.suid) && publicQueryVisible && readHeadAvailable) {
      const observedAtMs = Math.max(current.receivedAtMs, safeQuery.completedAtMs);
      const withinBound = observedAtMs <= deadlineMs;
      return {
        disposition: withinBound ? "pass" : "censored",
        boundMs: SAFE_BOUND_MS,
        firstVisibleAtMs: withinBound ? observedAtMs : null,
        responseRelativeMs: withinBound ? observedAtMs - responseCompletedAtMs : null,
        boundExceededAtMs: withinBound ? null : observedAtMs,
        safeHead,
        readHead: safeQuery.readHead,
        publicQuery: safeQuery,
        health: current,
      };
    }
    if (Date.now() >= deadlineMs) {
      return {
        disposition: "censored",
        boundMs: SAFE_BOUND_MS,
        firstVisibleAtMs: null,
        responseRelativeMs: null,
        boundExceededAtMs: Math.max(current.receivedAtMs, safeQuery.completedAtMs),
        safeHead,
        readHead: safeQuery.readHead,
        publicQuery: safeQuery,
        health: current,
      };
    }
    await sleep(Math.min(options.pollMs, Math.max(1, deadlineMs - Date.now())));
  }
}

async function observeCommand(options, report, sample) {
  sample.unsafe = await unsafeProbe(options, sample.target, sample);
  writeReceipt(options.reportPath, report);
  sample.safe = await safeProbe(options, sample.target, sample, report);
  writeReceipt(options.reportPath, report);
  if (sample.safe.disposition !== "pass") {
    sample.censored = true;
    sample.failure = `safe visibility did not reach ${sample.commit.suid} within ${SAFE_BOUND_MS}ms`;
    writeReceipt(options.reportPath, report);
    throw new Error(sample.failure);
  }
  for (const target of affectedTagReads(sample)) {
    sample.tagReads.push(await tagState(options, target.tag, target.projector, target.expectedVersion, target.expectedSuid));
  }
  sample.queryReads = await queryReads(options, sample.ids.roomId);
  writeReceipt(options.reportPath, report);
  return sample;
}

async function captureCommand(options, report, commandId, ids, ordinal, executor, sourceSnapshot = null) {
  if (sourceSnapshot !== null) {
    // Keep the exact external snapshot-read receipt separate from the command
    // receipt: the executor's snapshot-only path must never be mistaken for a
    // transport read-through.
    report.snapshotReads.push(sourceSnapshot);
  }
  const input = commandInput(commandId, ids, ordinal);
  const commit = await sendCommand(options, commandId, input, executor);
  const target = targetFor(commandId, ids);
  const sample = {
    ordinal,
    commandId,
    target,
    ids: { roomId: ids.roomId, reservationId: ids.reservationId },
    commit,
    unsafe: null,
    safe: null,
    healthSnapshots: [],
    tagReads: [],
    queryReads: null,
  };
  report.commands.push(sample);
  writeReceipt(options.reportPath, report);
  if (commit.status !== 200 || commit.kind !== "committed" || commit.suid === null) {
    sample.failure = "command was not an accepted committed event";
    sample.censored = true;
    writeReceipt(options.reportPath, report);
    throw new Error(`${commandId} did not commit (HTTP ${commit.status}, kind ${commit.kind ?? "unknown"})`);
  }
  return { sample, observation: observeCommand(options, report, sample) };
}

function summarize(values) {
  const observed = values.filter((value) => Number.isFinite(value));
  return { n: values.length, observedN: observed.length, censoredN: values.length - observed.length, p50Ms: nearestRank(observed, 0.5), p95Ms: nearestRank(observed, 0.95), maxMs: observed.length === 0 ? null : Math.max(...observed) };
}

function summarizeReport(report) {
  const rows = report.commands;
  const timing = (field) => summarize(rows.map((row) => {
    if (field === "response") return row.commit?.responseMs;
    if (field === "unsafe") return row.unsafe?.responseRelativeMs;
    if (field === "safe") return row.safe?.responseRelativeMs;
    return null;
  }));
  report.summary = {
    commandCount: rows.length,
    acceptedCount: rows.filter((row) => row.commit?.status === 200 && row.commit?.kind === "committed" && row.commit?.suid !== null).length,
    response: timing("response"),
    unsafe: timing("unsafe"),
    safe: timing("safe"),
    unsafeOverBoundCount: rows.filter((row) => row.unsafe?.disposition !== "pass").length,
    safeOverBoundCount: rows.filter((row) => row.safe?.disposition !== "pass").length,
    admission: Object.fromEntries([...new Set(rows.map((row) => row.commit?.admission))].map((value) => [value, rows.filter((row) => row.commit?.admission === value).length])),
    measurementOrigin: "response-completed-at-to-observed-public-read; command send/response clocks are retained separately",
  };
  report.acceptance = {
    coldFirst: report.contract.coldFirst === true,
    paced: report.contract.minimumInterSampleMs >= DEFAULT_PACE_MS,
    commandCount: rows.length >= DEFAULT_SAMPLE_COUNT,
    allAccepted: report.summary.acceptedCount === rows.length && rows.length >= DEFAULT_SAMPLE_COUNT,
    allUnsafeWithinBound: report.summary.unsafeOverBoundCount === 0,
    allSafeWithinBound: report.summary.safeOverBoundCount === 0,
    continuousWrites: rows.every((row, index) => index === 0 || row.commit.startedAtMs - rows[index - 1].commit.startedAtMs >= report.contract.minimumInterSampleMs)
      && rows.some((row, index) => index > 0 && rows[index - 1].safe?.firstVisibleAtMs !== null && rows[index - 1].safe?.firstVisibleAtMs !== undefined && row.commit.startedAtMs < rows[index - 1].safe.firstVisibleAtMs),
    readThroughThenSnapshotOnly: rows.some((row) => row.commit?.executor?.readMode === "read-through") && rows.some((row) => row.commit?.executor?.readMode === "snapshot-only"),
    tagStateAndQueryReads: rows.every((row) => Array.isArray(row.tagReads) && row.tagReads.length > 0
      && row.tagReads.every((tag) => tag.status === 200 && Number.isSafeInteger(tag.version) && (tag.expectedVersion === null || tag.version >= tag.expectedVersion) && atLeast(tag.lastSortedUniqueId, tag.expectedSuid))
      && row.queryReads?.room?.status === 200 && row.queryReads?.reservations?.status === 200
      && queryShowsTarget(row.target, row.queryReads)
      && typeof row.queryReads.reservations.readHead === "string"),
    coverageAndFrontierObserved: report.healthSnapshots.length > 0 && report.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses)),
    publicUnsafeAndSafeReads: rows.every((row) => Array.isArray(row.unsafe?.observations) && row.unsafe.observations.length > 0 && row.safe?.publicQuery?.status === 200 && row.safe?.safeHead !== undefined),
  };
}

export async function runG66Cohort(options) {
  const report = {
    schema: "sdt-g66-public-e2e/v1",
    task: "SDT-G66",
    phase: options.phase,
    runId: options.runId,
    baseUrl: options.baseUrl,
    sourceCommit: options.sourceCommit ?? null,
    deployedVersionId: options.versionId ?? null,
    startedAt: new Date().toISOString(),
    contract: {
      publicSurface: "one browser-equivalent paced session over /api/commands/*, unsafe projection reads and public safe query reads",
      commandPlan: "create-room plus eight reserve-room commands plus one cancel-reservation command",
      sampleCount: options.sampleCount,
      coldFirst: true,
      minimumInterSampleMs: options.paceMs,
      unsafeBoundMs: UNSAFE_BOUND_MS,
      safeBoundMs: SAFE_BOUND_MS,
      visibilityClock: "response-completed-at to observed public read; send/response clocks retained separately",
      continuousWrites: "visibility polling and safe-fence convergence never delay the next paced command; only source snapshot acquisition may gate executor input",
      safeQueryProof: "unsafe projection endpoint plus default public query body and readHead where the list wire supplies it",
      conformanceAuthorization: "Bearer supplied from protected token-file path; value not persisted",
      censoredRule: "any missing command/unsafe/safe clock is retained as censored and cannot pass",
    },
    commands: [],
    snapshotReads: [],
    healthSnapshots: [],
  };
  try {
    const initial = await health(options);
    report.healthSnapshots.push(initial);
    writeReceipt(options.reportPath, report);
    const ids = { phase: options.phase, roomId: `g66-${options.phase}-${options.runId.slice(0, 16)}`, reservationId: `g66-${options.phase}-${options.runId.slice(0, 12)}-r01` };
    const observations = [];
    const roomIssued = await captureCommand(options, report, "create-room", ids, 1, { readMode: "read-through", snapshots: [] });
    observations.push(roomIssued.observation);
    const room = roomIssued.sample;
    let previousResponseAtMs = room.commit.completedAtMs;
    let roomSnapshot = null;
    const lastReservationOrdinal = options.sampleCount - 1;
    for (let ordinal = 2; ordinal <= lastReservationOrdinal; ordinal += 1) {
      const reservationId = ordinal === 2 ? ids.reservationId : `g66-${options.phase}-${options.runId.slice(0, 12)}-r${String(ordinal - 1).padStart(2, "0")}`;
      ids.reservationId = reservationId;
      const notBefore = previousResponseAtMs + options.paceMs;
      if (Date.now() < notBefore) await sleep(notBefore - Date.now());
      const firstReservation = ordinal === 2;
      let snapshotReceipt = null;
      if (!firstReservation) {
        const snapshotResult = await waitForSnapshot(options, "room", ids.roomId, Date.now() + options.snapshotTimeoutMs);
        snapshotReceipt = { kind: "room", id: ids.roomId, observations: snapshotResult.observations, snapshot: snapshotResult.snapshot };
        roomSnapshot = snapshotResult.snapshot;
        if (roomSnapshot === null) throw new Error(`room snapshot unavailable before reservation ${ordinal}`);
      }
      const snapshots = firstReservation ? [] : [roomSnapshot, emptySnapshot("reservation", ids.reservationId)];
      const issued = await captureCommand(options, report, "reserve-room", ids, ordinal, firstReservation
        ? { readMode: "read-through", snapshots }
        : { readMode: "snapshot-only", snapshots }, snapshotReceipt);
      observations.push(issued.observation);
      previousResponseAtMs = issued.sample.commit.completedAtMs;
    }
    const cancelNotBefore = previousResponseAtMs + options.paceMs;
    if (Date.now() < cancelNotBefore) await sleep(cancelNotBefore - Date.now());
    const reservationSnapshotResult = await waitForSnapshot(options, "reservation", ids.reservationId, Date.now() + options.snapshotTimeoutMs);
    const reservationSnapshotReceipt = { kind: "reservation", id: ids.reservationId, observations: reservationSnapshotResult.observations, snapshot: reservationSnapshotResult.snapshot };
    if (reservationSnapshotResult.snapshot === null) throw new Error("reservation snapshot unavailable before cancel");
    const cancelIssued = await captureCommand(options, report, "cancel-reservation", ids, options.sampleCount, { readMode: "snapshot-only", snapshots: [reservationSnapshotResult.snapshot] }, reservationSnapshotReceipt);
    observations.push(cancelIssued.observation);
    await Promise.all(observations);
    summarizeReport(report);
    report.finishedAt = new Date().toISOString();
    report.status = "completed";
    writeReceipt(options.reportPath, report);
    return report;
  } catch (error) {
    summarizeReport(report);
    report.finishedAt = new Date().toISOString();
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    writeReceipt(options.reportPath, report);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  }
}

export function selfTest() {
  if (!atLeast("000000000000000000000000000002", "000000000000000000000000000001")) throw new Error("SUID ordering failed");
  if (nearestRank([1, 2, 3, 4], 0.95) !== 4) throw new Error("nearest rank failed");
  const path = fileURLToPath(import.meta.url);
  const source = readFileSync(path, "utf8");
  for (const requiredText of ["read-through", "snapshot-only", "coverageHistory", "safeLanePasses", "censored", "writeReceipt(options.reportPath, report)"]) {
    if (!source.includes(requiredText)) throw new Error(`G66 harness self-test missing ${requiredText}`);
  }
  process.stdout.write(`${JSON.stringify({ selfTest: "sdt-g66-public-e2e" })}\n`);
}

async function main() {
  const tokenFile = required("--token-file", argument("--token-file", process.env.G53_CONFORMANCE_TOKEN_FILE));
  if (!existsSync(tokenFile)) throw new Error("protected conformance token file does not exist");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length === 0) throw new Error("protected conformance token file is empty");
  const output = resolve(argument("--report", `.artifacts/sdt-g66-${argument("--phase", "cohort")}.json`));
  const options = {
    baseUrl: required("--base-url", argument("--base-url", process.env.G66_BASE_URL)).replace(/\/$/, ""),
    token,
    phase: required("--phase", argument("--phase", "cohort")),
    runId: runId(argument("--run-id", `${Date.now()}-g66`)),
    sourceCommit: argument("--source-commit", process.env.G66_SOURCE_COMMIT),
    versionId: argument("--version-id", process.env.G66_VERSION_ID),
    sampleCount: integer("--samples", argument("--samples", String(DEFAULT_SAMPLE_COUNT)), DEFAULT_SAMPLE_COUNT),
    paceMs: integer("--pace-ms", argument("--pace-ms", String(DEFAULT_PACE_MS)), DEFAULT_PACE_MS),
    pollMs: integer("--poll-ms", argument("--poll-ms", "2000"), 100),
    snapshotTimeoutMs: integer("--snapshot-timeout-ms", argument("--snapshot-timeout-ms", "30000"), 1000),
    reportPath: output,
  };
  try {
    const report = await runG66Cohort(options);
    process.stdout.write(`${JSON.stringify({ task: report.task, phase: report.phase, status: report.status, output, acceptance: report.acceptance }, null, 2)}\n`);
  } catch (error) {
    if (error?.report !== undefined) writeReceipt(output, error.report);
    process.stderr.write(`${JSON.stringify({ task: "SDT-G66", phase: options.phase, status: "failed", output, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv.includes("--self-test")) selfTest();
else if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) main();

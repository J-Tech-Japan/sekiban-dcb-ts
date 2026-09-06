#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_BOUND_MS = 120_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { code: "non_json_response" };
  }
}

function persist(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function requestJson(baseUrl, path, init = {}) {
  const startedAtMs = Date.now();
  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rawBody = await response.text();
    const receivedAtMs = Date.now();
    return {
      status: response.status,
      body: parseJson(rawBody),
      rawBody,
      startedAtMs,
      receivedAtMs,
      elapsedMs: receivedAtMs - startedAtMs,
      cfRay: response.headers.get("cf-ray"),
      globalAdmission: response.headers.get("x-sdt-global-admission"),
    };
  } catch (error) {
    const receivedAtMs = Date.now();
    return {
      status: null,
      body: null,
      rawBody: "",
      startedAtMs,
      receivedAtMs,
      elapsedMs: receivedAtMs - startedAtMs,
      cfRay: null,
      globalAdmission: null,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not a JSON object`);
  return value;
}

function requireCommitted(result, label) {
  if (result.status !== 200 || result.body?.kind !== "committed") {
    throw new Error(`${label} failed HTTP ${String(result.status)}: ${result.rawBody}`);
  }
  const body = requireRecord(result.body, label);
  const response = requireRecord(body.response, `${label}.response`);
  if (!Array.isArray(response.writtenEvents) || response.writtenEvents.length === 0) throw new Error(`${label} omitted writtenEvents`);
  const event = requireRecord(response.writtenEvents[0], `${label}.writtenEvents[0]`);
  if (typeof event.sortableUniqueIdValue !== "string" || event.sortableUniqueIdValue.length === 0) throw new Error(`${label} omitted a SUID`);
  return event.sortableUniqueIdValue;
}

function listItems(body, label) {
  const value = body.itemsJson ?? body.items;
  const items = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(items)) throw new Error(`${label} omitted itemsJson`);
  return items;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} was not a non-negative integer: ${String(value)}`);
  return value;
}

function pageCount(body, pageSize) {
  const totalCount = nonNegativeInteger(body.totalCount, "reservation list totalCount");
  const declared = Number.isSafeInteger(body.totalPages) && body.totalPages > 0
    ? body.totalPages
    : Math.max(1, Math.ceil(totalCount / pageSize));
  return { totalCount, totalPages: Math.max(1, declared) };
}

async function scanReservationPages(baseUrl, reservationId, pageSize) {
  const pages = [];
  let plannedPages = 1;
  let found = null;
  let firstPageRead = null;
  for (let pageNumber = 1; pageNumber <= plannedPages; pageNumber += 1) {
    const result = await requestJson(
      baseUrl,
      `/api/read/reservations?pageNumber=${pageNumber}&pageSize=${pageSize}&newestFirst=true`,
    );
    if (result.status !== 200 || result.transportError !== undefined) {
      throw new Error(`reservation list page ${pageNumber} failed HTTP ${String(result.status)}: ${result.transportError ?? result.rawBody}`);
    }
    const body = requireRecord(result.body, `reservation list page ${pageNumber}`);
    const items = listItems(body, `reservation list page ${pageNumber}`);
    const counts = pageCount(body, pageSize);
    plannedPages = Math.max(plannedPages, counts.totalPages);
    const page = {
      pageNumber,
      status: result.status,
      startedAtMs: result.startedAtMs,
      receivedAtMs: result.receivedAtMs,
      requestMs: result.elapsedMs,
      cfRay: result.cfRay,
      totalCount: counts.totalCount,
      totalPages: counts.totalPages,
      currentPage: body.currentPage ?? null,
      pageSize: body.pageSize ?? pageSize,
      itemCount: items.length,
      containsReservation: items.some((item) => item?.reservationId === reservationId),
      rawBody: result.rawBody,
    };
    pages.push(page);
    if (firstPageRead === null) firstPageRead = page;
    if (found === null) found = items.find((item) => item?.reservationId === reservationId) ?? null;
  }
  return {
    found,
    pages,
    pageCount: pages.length,
    firstPage: firstPageRead,
    totalCount: firstPageRead?.totalCount ?? 0,
    totalPages: plannedPages,
  };
}

async function readUntilListed(options, report, sample) {
  const startedAtMs = sample.commit.receivedAtMs;
  const deadlineAtMs = startedAtMs + options.boundMs;
  const observations = [];
  while (Date.now() < deadlineAtMs) {
    const scan = await scanReservationPages(options.baseUrl, sample.reservationId, options.pageSize);
    const observedAtMs = Date.now();
    const observation = {
      observedAtMs,
      commitToObservationMs: observedAtMs - startedAtMs,
      containsReservation: scan.found !== null,
      pageCount: scan.pageCount,
      totalPages: scan.totalPages,
      totalCount: scan.totalCount,
      pageItemsTotal: scan.pages.reduce((sum, page) => sum + page.itemCount, 0),
      pages: scan.pages,
    };
    observations.push(observation);
    sample.observations = observations;
    persist(options.reportPath, report);
    if (scan.found !== null) {
      return {
        disposition: observation.commitToObservationMs > options.unsafeBoundMs ? "over-5000ms" : "within-5000ms",
        firstVisibleAtMs: observedAtMs,
        commitToFirstVisibilityMs: observation.commitToObservationMs,
        item: scan.found,
        observations,
      };
    }
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(options.pollMs, remainingMs));
  }
  return {
    disposition: "missing-by-120000ms",
    firstVisibleAtMs: null,
    commitToFirstVisibilityMs: null,
    item: null,
    observations,
  };
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function metrics(reservations, unsafeBoundMs) {
  const observed = reservations
    .map((sample) => sample.visibility.commitToFirstVisibilityMs)
    .filter((value) => Number.isFinite(value));
  const countOver = reservations.filter((sample) => {
    const value = sample.visibility.commitToFirstVisibilityMs;
    return value !== null && value > unsafeBoundMs;
  }).length;
  const countAtOrOverOrMissing = reservations.filter((sample) => {
    const value = sample.visibility.commitToFirstVisibilityMs;
    return value === null || value >= unsafeBoundMs;
  }).length;
  return {
    n: reservations.length,
    observedN: observed.length,
    censoredN: reservations.length - observed.length,
    p50MsObservedOnly: nearestRank(observed, 0.5),
    p95MsObservedOnly: nearestRank(observed, 0.95),
    countOver5000MsStrict: countOver,
    countAtOrOver5000OrMissing: countAtOrOverOrMissing,
    fullCohortPercentiles: observed.length === reservations.length ? "observed-all-samples" : "censored; not claimed",
  };
}

const options = {
  variant: required("--variant", argument("--variant")),
  sourceCommit: required("--source-commit", argument("--source-commit")),
  deployedVersionId: argument("--deployed-version-id", null),
  baseUrl: required("--base-url", argument("--base-url")).replace(/\/$/, ""),
  reportPath: resolve(required("--report", argument("--report"))),
  count: integer("--count", argument("--count", "10"), 1),
  paceMs: integer("--pace-ms", argument("--pace-ms", "10000"), 10000),
  pageSize: integer("--page-size", argument("--page-size", String(DEFAULT_PAGE_SIZE)), 1),
  pollMs: integer("--poll-ms", argument("--poll-ms", String(DEFAULT_POLL_MS)), 100),
  boundMs: integer("--bound-ms", argument("--bound-ms", String(DEFAULT_BOUND_MS)), 1),
  unsafeBoundMs: 5000,
};

const runId = crypto.randomUUID();
const idStem = runId.replaceAll("-", "").slice(0, 16);
const report = {
  schema: "sdt-g65-w128-public-cohort/v1",
  task: "SDT-G65-W128-D1-unavailable",
  status: "running",
  variant: options.variant,
  sourceCommit: options.sourceCommit,
  deployedVersionId: options.deployedVersionId,
  baseUrl: options.baseUrl,
  runId,
  startedAt: new Date().toISOString(),
  contract: {
    publicSurfaceOnly: [
      "POST /api/commands/create-room",
      "POST /api/commands/reserve-room",
      "GET /api/read/reservations",
    ],
    conformanceHealthCalled: false,
    conformanceTokenUsed: false,
    roomProtocol: "G15/G16 create-room body {roomId,name:SDT-G15}",
    reservationProtocol: "G15/G16 reserve-room body {roomId,reservationId,userId:g15}",
    pacedReservationCommits: options.count,
    minimumCommitSpacingMs: options.paceMs,
    coldFirstSample: true,
    timing: "command response receivedAtMs to first public-list observation containing the reservation ID",
    unsafeCountBoundMs: options.unsafeBoundMs,
    observationCeilingMs: options.boundMs,
    pagination: `pageSize=${options.pageSize}; every page declared by each scan fetched; target presence only`,
    rawReceiptPersistence: "flushed after setup, every list scan, each accepted commit, and each completed sample",
  },
  setupRoom: null,
  reservations: [],
  metrics: null,
};

async function run() {
  persist(options.reportPath, report);
  const roomId = `g65-unavailable-room-${idStem}`;
  const create = await requestJson(options.baseUrl, "/api/commands/create-room", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, name: "SDT-G65 D1 unavailable" }),
  });
  const createRecord = {
    method: "POST",
    path: "/api/commands/create-room",
    requestBody: { roomId, name: "SDT-G65 D1 unavailable" },
    ...create,
  };
  const createSuid = requireCommitted(create, "create-room");
  report.setupRoom = { roomId, commit: { ...createRecord, suid: createSuid } };
  persist(options.reportPath, report);

  let previousCommitReceivedAtMs = null;
  for (let ordinal = 1; ordinal <= options.count; ordinal += 1) {
    if (previousCommitReceivedAtMs !== null) {
      const earliestStartAtMs = previousCommitReceivedAtMs + options.paceMs;
      while (Date.now() < earliestStartAtMs) await sleep(Math.min(1000, earliestStartAtMs - Date.now()));
    }
    const reservationId = `g65-unavailable-reservation-${idStem}-${ordinal}`;
    const commit = await requestJson(options.baseUrl, "/api/commands/reserve-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, reservationId, userId: "g65-unavailable" }),
    });
    const commitSuid = requireCommitted(commit, `reserve-room #${ordinal}`);
    const commitRecord = {
      method: "POST",
      path: "/api/commands/reserve-room",
      requestBody: { roomId, reservationId, userId: "g65-unavailable" },
      ...commit,
      suid: commitSuid,
    };
    const sample = {
      ordinal,
      reservationId,
      suid: commitSuid,
      commit: commitRecord,
      pacing: {
        previousCommitReceivedAtMs,
        commitStartedAtMs: commit.startedAtMs,
        previousCommitToThisCommitStartMs: previousCommitReceivedAtMs === null ? null : commit.startedAtMs - previousCommitReceivedAtMs,
        requiredMs: options.paceMs,
      },
      observations: [],
      visibility: null,
    };
    report.reservations.push(sample);
    previousCommitReceivedAtMs = commit.receivedAtMs;
    persist(options.reportPath, report);
    sample.visibility = await readUntilListed(options, report, sample);
    persist(options.reportPath, report);
  }
  report.metrics = metrics(report.reservations, options.unsafeBoundMs);
  report.status = "completed";
  report.finishedAt = new Date().toISOString();
  persist(options.reportPath, report);
  process.stdout.write(JSON.stringify({ status: report.status, variant: options.variant, runId, report: options.reportPath, metrics: report.metrics }) + "\n");
}

run().catch((error) => {
  report.status = "blocked-public-protocol";
  report.failure = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  persist(options.reportPath, report);
  process.stderr.write(`${report.status}: ${report.failure}\n`);
  process.exitCode = 1;
});

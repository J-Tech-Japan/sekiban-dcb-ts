import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SAFE_BOUND_MS = 180_000;
const UNSAFE_BOUND_MS = 5_000;
const PACE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 1_000;
const SUID_PATTERN = /^\d{30}$/;

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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function iso(milliseconds) {
  return Number.isSafeInteger(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function compareSuid(left, right) {
  const leftBytes = new TextEncoder().encode(left ?? "");
  const rightBytes = new TextEncoder().encode(right ?? "");
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function reaches(actual, expected) {
  return typeof actual === "string" && SUID_PATTERN.test(actual) && compareSuid(actual, expected) >= 0;
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

function parseJson(rawBody) {
  try { return JSON.parse(rawBody); } catch { return { code: "non_json_response", raw: rawBody }; }
}

function persist(outputPath, report) {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function rawResponse(result) {
  return {
    status: result.status,
    startedAtMs: result.startedAtMs,
    startedAt: iso(result.startedAtMs),
    receivedAtMs: result.receivedAtMs,
    receivedAt: iso(result.receivedAtMs),
    responseMs: result.responseMs,
    cfRay: result.cfRay,
    body: result.body,
    rawBody: result.rawBody,
  };
}

async function requestJson(baseUrl, pathname, init = {}) {
  const startedAtMs = Date.now();
  let response;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const receivedAtMs = Date.now();
    return {
      status: null,
      startedAtMs,
      receivedAtMs,
      responseMs: receivedAtMs - startedAtMs,
      cfRay: null,
      body: { code: "fetch_error", error: error instanceof Error ? error.message : String(error) },
      rawBody: "",
      fetchError: error instanceof Error ? error.message : String(error),
    };
  }
  const receivedAtMs = Date.now();
  const rawBody = await response.text();
  return {
    status: response.status,
    startedAtMs,
    receivedAtMs,
    responseMs: receivedAtMs - startedAtMs,
    cfRay: response.headers.get("cf-ray"),
    body: parseJson(rawBody),
    rawBody,
  };
}

function authenticatedHeaders(token, contentType = false) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(contentType ? { "content-type": "application/json" } : {}),
  };
}

function extractSuid(body) {
  const response = body !== null && typeof body === "object" && body.response !== null && typeof body.response === "object"
    ? body.response
    : body;
  const writtenEvents = response !== null && typeof response === "object" && Array.isArray(response.writtenEvents)
    ? response.writtenEvents
    : [];
  const suid = writtenEvents[0]?.sortableUniqueIdValue;
  if (typeof suid !== "string" || !SUID_PATTERN.test(suid)) {
    throw new Error("accepted command omitted a 30-digit sortableUniqueIdValue");
  }
  return suid;
}

function responseError(label, result) {
  return `${label} failed HTTP ${String(result.status)}: ${JSON.stringify(result.body)}`;
}

async function acceptedCommand(report, outputPath, baseUrl, pathname, body, token = null) {
  const headers = token === null
    ? { accept: "application/json", "content-type": "application/json" }
    : authenticatedHeaders(token, true);
  const result = await requestJson(baseUrl, pathname, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const receipt = {
    request: { method: "POST", path: pathname, body },
    response: rawResponse(result),
  };
  if (result.status !== 200) {
    report.failures.push({ label: pathname, receipt });
    persist(outputPath, report);
    throw new Error(responseError(pathname, result));
  }
  const suid = extractSuid(result.body);
  return { ...result, suid, receipt };
}

function coverageSummary(body) {
  const coverage = body?.coverage;
  const lag = body?.lag;
  const history = Array.isArray(body?.coverageHistory) ? body.coverageHistory : [];
  return {
    kind: typeof coverage?.kind === "string" ? coverage.kind : "unknown",
    reason: coverage?.reason === null || coverage?.reason === undefined ? null : String(coverage.reason),
    partitionTag: coverage?.partitionTag === null || coverage?.partitionTag === undefined ? null : String(coverage.partitionTag),
    frontierSuid: typeof coverage?.frontierSuid === "string" ? coverage.frontierSuid : "",
    observedAt: Number.isSafeInteger(coverage?.observedAt) ? coverage.observedAt : null,
    coverageHistory: history.map((entry) => ({
      tickId: typeof entry?.tickId === "string" ? entry.tickId : "",
      kind: typeof entry?.kind === "string" ? entry.kind : "unknown",
      reason: entry?.reason === null || entry?.reason === undefined ? null : String(entry.reason),
      partitionTag: entry?.partitionTag === null || entry?.partitionTag === undefined ? null : String(entry.partitionTag),
      frontierSuid: typeof entry?.frontierSuid === "string" ? entry.frontierSuid : "",
      observedAt: Number.isSafeInteger(entry?.observedAt) ? entry.observedAt : null,
    })),
    lag: {
      estimateMs: typeof lag?.estimateMs === "number" ? lag.estimateMs : null,
      observedAt: Number.isSafeInteger(lag?.observedAt) ? lag.observedAt : null,
      decayedMs: typeof lag?.decayedMs === "number" ? lag.decayedMs : null,
      safeWindowMs: typeof lag?.safeWindowMs === "number" ? lag.safeWindowMs : null,
      ceilingExceeded: lag?.ceilingExceeded === true,
    },
    materializedViews: Array.isArray(body?.materializedViews) ? body.materializedViews.map((view) => ({
      viewId: typeof view?.viewId === "string" ? view.viewId : "",
      safeHead: typeof view?.safeHead === "string" ? view.safeHead : "",
      generation: typeof view?.generation === "number" ? view.generation : null,
      unsafeRows: typeof view?.unsafeRows === "number" ? view.unsafeRows : null,
      unsafeReceipts: typeof view?.unsafeReceipts === "number" ? view.unsafeReceipts : null,
    })) : [],
    liveProjections: Array.isArray(body?.liveProjections) ? body.liveProjections.map((projection) => ({
      projectorId: typeof projection?.projectorId === "string" ? projection.projectorId : "",
      head: typeof projection?.head === "string" ? projection.head : "",
      headAgeMs: typeof projection?.headAgeMs === "number" ? projection.headAgeMs : null,
      lastPollAt: Number.isSafeInteger(projection?.lastPollAt) ? projection.lastPollAt : null,
      pollStatus: typeof projection?.pollStatus === "string" ? projection.pollStatus : "never-invoked",
      pollReason: projection?.pollReason === null || projection?.pollReason === undefined ? null : String(projection.pollReason),
    })) : [],
    globalHead: typeof body?.globalHead === "string" ? body.globalHead : "",
  };
}

async function readHealth(report, outputPath, baseUrl, token, label = "health") {
  const pathname = "/conformance/v1/read-health";
  const result = await requestJson(baseUrl, pathname, { headers: authenticatedHeaders(token) });
  const receipt = { request: { method: "GET", path: pathname }, response: rawResponse(result) };
  if (result.status === 403 && result.body?.code === "unauthorized") {
    report.failures.push({ label, authorization: true, receipt });
    persist(outputPath, report);
    throw new Error("conformance route returned application unauthorized");
  }
  if (result.status !== 200) {
    report.failures.push({ label, receipt });
    persist(outputPath, report);
    throw new Error(responseError(label, result));
  }
  const snapshot = {
    observedAtMs: result.receivedAtMs,
    observedAt: iso(result.receivedAtMs),
    responseMs: result.responseMs,
    coverage: coverageSummary(result.body),
    rawResponse: rawResponse(result),
  };
  report.healthSnapshots.push(snapshot);
  persist(outputPath, report);
  return snapshot;
}

function listItems(body) {
  if (body === null || typeof body !== "object" || typeof body.itemsJson !== "string") return [];
  try {
    const items = JSON.parse(body.itemsJson);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

async function readReservationPage(baseUrl, pageNumber) {
  const pathname = `/api/read/reservations?pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}&newestFirst=true`;
  const result = await requestJson(baseUrl, pathname, { headers: { accept: "application/json" } });
  return {
    request: { method: "GET", path: pathname },
    response: rawResponse(result),
    items: listItems(result.body),
    totalCount: Number.isSafeInteger(Number(result.body?.totalCount)) ? Number(result.body.totalCount) : null,
  };
}

async function readAllReservations(report, outputPath, baseUrl, reservationId = null) {
  const pages = [];
  let pageNumber = 1;
  let requiredPages = 1;
  while (pageNumber <= requiredPages) {
    const page = await readReservationPage(baseUrl, pageNumber);
    pages.push(page);
    if (page.response.status !== 200) {
      report.failures.push({ label: "public reservation list", receipt: page });
      persist(outputPath, report);
      throw new Error(responseError("public reservation list", page.response));
    }
    if (page.totalCount !== null) requiredPages = Math.max(requiredPages, Math.ceil(page.totalCount / PAGE_SIZE));
    pageNumber += 1;
    report.publicReadReceipts.push({
      atMs: page.response.receivedAtMs,
      at: iso(page.response.receivedAtMs),
      reservationId,
      pages: [page],
      completePageCount: pages.length,
      expectedPageCount: requiredPages,
    });
    persist(outputPath, report);
  }
  const items = pages.flatMap((page) => page.items);
  const totalCount = Math.max(0, ...pages.map((page) => page.totalCount ?? 0));
  const visible = reservationId === null ? false : items.some((item) => item?.reservationId === reservationId);
  return {
    atMs: pages.at(-1)?.response.receivedAtMs ?? Date.now(),
    at: iso(pages.at(-1)?.response.receivedAtMs ?? Date.now()),
    reservationId,
    pageCount: pages.length,
    totalCount,
    itemCount: items.length,
    visible,
    readHead: typeof pages[0]?.response.body?.readHead === "string" ? pages[0].response.body.readHead : null,
    pages,
  };
}

async function observeUnsafe(report, outputPath, baseUrl, sample) {
  const observations = sample.unsafe?.observations ?? [];
  const deadlineMs = sample.commit.receivedAtMs + UNSAFE_BOUND_MS;
  for (;;) {
    const read = await readAllReservations(report, outputPath, baseUrl, sample.reservationId);
    const observation = {
      atMs: read.atMs,
      at: read.at,
      elapsedMs: read.atMs - sample.commit.receivedAtMs,
      visible: read.visible,
      pageCount: read.pageCount,
      totalCount: read.totalCount,
      itemCount: read.itemCount,
      readHead: read.readHead,
      pages: read.pages,
    };
    observations.push(observation);
    if (read.visible && sample.unsafe.firstVisibleAtMs === null) {
      sample.unsafe.firstVisibleAtMs = read.atMs;
      sample.unsafe.firstVisibleAt = iso(read.atMs);
      sample.unsafe.firstVisibleCommitToUnsafeMs = read.atMs - sample.commit.receivedAtMs;
    }
    sample.unsafe.observations = observations;
    persist(outputPath, report);
    if (sample.unsafe.firstVisibleAtMs !== null || Date.now() >= deadlineMs) break;
    await sleep(Math.min(2_000, Math.max(1, deadlineMs - Date.now())));
  }
  sample.unsafe.boundCheckedAtMs = Date.now();
  sample.unsafe.censoredAtBound = sample.unsafe.firstVisibleAtMs === null || sample.unsafe.firstVisibleAtMs > deadlineMs;
  sample.unsafe.disposition = sample.unsafe.firstVisibleAtMs === null
    ? "censored-at-5000ms"
    : sample.unsafe.firstVisibleAtMs <= deadlineMs ? "observed-within-5000ms" : "observed-over-5000ms";
  persist(outputPath, report);
}

async function observePendingUnsafe(report, outputPath, baseUrl) {
  for (const sample of report.reservations) {
    if (sample.unsafe.firstVisibleAtMs !== null) continue;
    const read = await readAllReservations(report, outputPath, baseUrl, sample.reservationId);
    if (read.visible) {
      sample.unsafe.firstVisibleAtMs = read.atMs;
      sample.unsafe.firstVisibleAt = read.at;
      sample.unsafe.firstVisibleCommitToUnsafeMs = read.atMs - sample.commit.receivedAtMs;
      sample.unsafe.censoredAtBound = sample.unsafe.firstVisibleAtMs > sample.commit.receivedAtMs + UNSAFE_BOUND_MS;
      sample.unsafe.disposition = sample.unsafe.censoredAtBound ? "observed-over-5000ms" : "observed-within-5000ms";
      persist(outputPath, report);
    }
  }
}

function tagTargets(roomId, roomSuid, reservations) {
  return [
    { kind: "room", id: roomId, tagStateId: `room:${roomId}:RoomProjector`, expectedSuid: roomSuid },
    ...reservations.map((sample) => ({
      kind: "reservation",
      id: sample.reservationId,
      tagStateId: `reservation:${sample.reservationId}:ReservationProjector`,
      expectedSuid: sample.suid,
    })),
  ];
}

async function readTagState(report, outputPath, baseUrl, token, target) {
  const pathname = "/conformance/v1/api/sekiban/serialized/tag-state";
  const requestBody = { tagStateId: target.tagStateId };
  const result = await requestJson(baseUrl, pathname, {
    method: "POST",
    headers: authenticatedHeaders(token, true),
    body: JSON.stringify(requestBody),
  });
  const receipt = {
    target,
    request: { method: "POST", path: pathname, body: requestBody },
    response: rawResponse(result),
  };
  if (result.status === 403 && result.body?.code === "unauthorized") {
    report.failures.push({ label: "tag-state", authorization: true, receipt });
    persist(outputPath, report);
    throw new Error("conformance route returned application unauthorized");
  }
  if (result.status !== 200) {
    report.failures.push({ label: "tag-state", receipt });
    persist(outputPath, report);
    return { ...receipt, ok: false, lastSortedUniqueId: "", version: null };
  }
  const lastSortedUniqueId = typeof result.body?.lastSortedUniqueId === "string"
    ? result.body.lastSortedUniqueId
    : typeof result.body?.lastSortableUniqueId === "string" ? result.body.lastSortableUniqueId : "";
  const rawVersion = result.body?.version;
  const version = Number.isSafeInteger(rawVersion)
    ? rawVersion
    : typeof rawVersion === "string" && /^\d+$/.test(rawVersion) ? Number(rawVersion) : null;
  return { ...receipt, ok: true, lastSortedUniqueId, version };
}

async function readAllTagStates(report, outputPath, baseUrl, token, targets, observedAtMs) {
  const states = [];
  for (const target of targets) {
    const state = await readTagState(report, outputPath, baseUrl, token, target);
    states.push({ observedAtMs, observedAt: iso(observedAtMs), ...state });
    report.tagStateReads.push(states.at(-1));
    persist(outputPath, report);
  }
  return states;
}

function projectorOutcome(projection) {
  const status = String(projection?.pollStatus ?? "").toLowerCase();
  if (status.includes("throw")) return "throw";
  if (status.includes("no-work") || status.includes("no_work")) return "no-work";
  if (status.includes("fenced") || status.includes("gated") || status.includes("completeness")) return "fenced";
  if (status.includes("advanced")) return "advanced";
  return "unknown";
}

function scheduledPolls(healthSnapshots) {
  const ticks = new Map();
  for (const snapshot of healthSnapshots) {
    const observedAt = snapshot.coverage.observedAt;
    if (!Number.isSafeInteger(observedAt)) continue;
    const historyEntry = snapshot.coverage.coverageHistory.find((entry) => entry.observedAt === observedAt);
    const tickId = historyEntry?.tickId || `scheduled:${observedAt}`;
    const current = ticks.get(tickId) ?? {
      tickId,
      observedAt,
      observedAtIso: iso(observedAt),
      coverage: {
        kind: snapshot.coverage.kind,
        reason: snapshot.coverage.reason,
        partitionTag: snapshot.coverage.partitionTag,
        frontierSuid: snapshot.coverage.frontierSuid,
      },
      snapshots: [],
      projectors: {},
    };
    current.snapshots.push({
      observedAtMs: snapshot.observedAtMs,
      observedAt: snapshot.observedAt,
      coverage: snapshot.coverage,
      liveProjections: snapshot.coverage.liveProjections,
      materializedViews: snapshot.coverage.materializedViews,
      rawResponse: snapshot.rawResponse,
    });
    for (const projection of snapshot.coverage.liveProjections) {
      current.projectors[projection.projectorId] = {
        projectorId: projection.projectorId,
        attempted: Number.isSafeInteger(projection.lastPollAt),
        attemptedAt: projection.lastPollAt,
        outcome: projectorOutcome(projection),
        rawOutcome: projection.pollStatus,
        reason: projection.pollReason,
        head: projection.head,
        headAgeMs: projection.headAgeMs,
      };
    }
    ticks.set(tickId, current);
  }
  return [...ticks.values()].sort((left, right) => left.observedAt - right.observedAt).map((tick) => ({
    ...tick,
    projectors: Object.values(tick.projectors),
    everyRegisteredProjectorAttempted: ["RoomProjector", "ReservationProjector"].every((id) => tick.projectors[id]?.attempted === true),
  }));
}

function updateSampleReach(report, snapshot, tagStates) {
  const projects = snapshot.coverage.liveProjections;
  for (const sample of report.reservations) {
    for (const projectorId of ["RoomProjector", "ReservationProjector"]) {
      const projection = projects.find((candidate) => candidate.projectorId === projectorId);
      if (projection !== undefined && reaches(projection.head, sample.suid) && sample.projectorHeadReachedAt[projectorId] === null) {
        sample.projectorHeadReachedAt[projectorId] = snapshot.observedAtMs;
        sample.projectorHeadReachedAtIso[projectorId] = snapshot.observedAt;
      }
    }
  }
  for (const state of tagStates) {
    if (state.ok && state.version !== null && reaches(state.lastSortedUniqueId, state.target.expectedSuid)) {
      const sample = state.target.kind === "reservation"
        ? report.reservations.find((candidate) => candidate.reservationId === state.target.id)
        : null;
      if (sample !== null && sample !== undefined && sample.tagStateReachedAtMs === null) {
        sample.tagStateReachedAtMs = state.observedAtMs;
        sample.tagStateReachedAt = state.observedAt;
      }
    }
  }
}

function currentProjectorHeads(snapshot) {
  return Object.fromEntries(snapshot.coverage.liveProjections.map((projection) => [projection.projectorId, projection.head]));
}

function allFinalProjectorsAtTarget(snapshot, targetSuid) {
  return ["RoomProjector", "ReservationProjector"].every((projectorId) => {
    const projection = snapshot.coverage.liveProjections.find((candidate) => candidate.projectorId === projectorId);
    return projection !== undefined && reaches(projection.head, targetSuid);
  });
}

function allTagStatesAtTarget(states, targets) {
  const byId = new Map(states.map((state) => [state.target.tagStateId, state]));
  return targets.every((target) => {
    const state = byId.get(target.tagStateId);
    return state?.ok === true && state.version !== null && reaches(state.lastSortedUniqueId, target.expectedSuid);
  });
}

function finaliseTiming(report) {
  const unsafeValues = report.reservations
    .map((sample) => sample.unsafe.firstVisibleCommitToUnsafeMs)
    .filter((value) => typeof value === "number");
  const safeValues = report.reservations
    .map((sample) => sample.finalProjectorHeadReachedAtMs === null ? null : sample.finalProjectorHeadReachedAtMs - sample.commit.receivedAtMs)
    .filter((value) => typeof value === "number");
  report.timing = {
    unsafeRecordedOnly: {
      n: report.reservations.length,
      observedN: unsafeValues.length,
      censoredN: report.reservations.filter((sample) => sample.unsafe.firstVisibleAtMs === null).length,
      over5000N: report.reservations.filter((sample) => sample.unsafe.firstVisibleAtMs === null || sample.unsafe.firstVisibleAtMs > sample.commit.receivedAtMs + UNSAFE_BOUND_MS).length,
      p50Ms: nearestRank(unsafeValues, 0.5),
      p95Ms: nearestRank(unsafeValues, 0.95),
    },
    projectorHeadToFinal: {
      n: safeValues.length,
      censoredN: report.reservations.length - safeValues.length,
      p50Ms: nearestRank(safeValues, 0.5),
      p95Ms: nearestRank(safeValues, 0.95),
    },
  };
}

async function run(options) {
  const startedAtMs = Date.now();
  const runId = crypto.randomUUID();
  const report = {
    schema: "sdt-g61-w148-public-cohort/v1",
    task: "SDT-G61",
    runId,
    baseUrl: options.baseUrl,
    serviceId: options.serviceId,
    sourceHead: options.sourceHead,
    startedAtMs,
    startedAt: iso(startedAtMs),
    protocol: {
      coldFirstSampleIncluded: true,
      cohortSize: options.count,
      minimumPaceMs: PACE_MS,
      safeBoundMs: SAFE_BOUND_MS,
      unsafeBoundMs: UNSAFE_BOUND_MS,
      publicReservationListPageSize: PAGE_SIZE,
      publicReservationListFullyPaged: true,
      unsafeDisposition: "recorded only; SDT-G60 owns the 5000ms contract",
      projectorHeadConvergence: "measured for G61; no repair in W148",
      tagStateProof: "each cohort tag is read with committed version and lastSortedUniqueId",
    },
    deployment: options.deployment,
    healthSnapshots: [],
    publicReadReceipts: [],
    tagStateReads: [],
    reservations: [],
    failures: [],
  };
  try {
    const healthBefore = await readHealth(report, options.outputPath, options.baseUrl, options.token, "health-before");
    report.healthBefore = healthBefore;
    const roomId = `g61-room-${runId.slice(0, 12)}`;
    const roomBody = { roomId, name: `SDT-G61 W148 ${runId.slice(0, 8)}` };
    const room = await acceptedCommand(report, options.outputPath, options.baseUrl, "/api/commands/create-room", roomBody);
    report.setupRoom = {
      roomId,
      suid: room.suid,
      request: room.receipt.request,
      response: room.receipt.response,
    };
    persist(options.outputPath, report);

    let previousCommitAtMs = room.receivedAtMs;
    for (let ordinal = 1; ordinal <= options.count; ordinal += 1) {
      const notBeforeMs = previousCommitAtMs + PACE_MS;
      while (Date.now() < notBeforeMs) {
        await readHealth(report, options.outputPath, options.baseUrl, options.token, `pace-before-${ordinal}`);
        const remainingMs = notBeforeMs - Date.now();
        if (remainingMs > 0) await sleep(Math.min(2_000, remainingMs));
      }
      const reservationId = `g61-reservation-${runId.slice(0, 12)}-${ordinal}`;
      const body = { roomId, reservationId, userId: `g61-user-${ordinal}` };
      const commit = await acceptedCommand(report, options.outputPath, options.baseUrl, "/api/commands/reserve-room", body);
      const sample = {
        ordinal,
        reservationId,
        request: commit.receipt.request,
        commit: {
          receivedAtMs: commit.receivedAtMs,
          receivedAt: iso(commit.receivedAtMs),
          responseMs: commit.responseMs,
          suid: commit.suid,
          rawResponse: commit.receipt.response,
        },
        pacing: {
          previousCommitToThisCommitMs: commit.receivedAtMs - previousCommitAtMs,
          requiredMs: PACE_MS,
          satisfied: commit.receivedAtMs - previousCommitAtMs >= PACE_MS,
        },
        suid: commit.suid,
        unsafe: {
          boundMs: UNSAFE_BOUND_MS,
          firstVisibleAtMs: null,
          firstVisibleAt: null,
          firstVisibleCommitToUnsafeMs: null,
          boundCheckedAtMs: null,
          censoredAtBound: true,
          disposition: "pending",
          observations: [],
        },
        projectorHeadReachedAt: { RoomProjector: null, ReservationProjector: null },
        projectorHeadReachedAtIso: { RoomProjector: null, ReservationProjector: null },
        tagStateReachedAtMs: null,
        tagStateReachedAt: null,
        finalProjectorHeadReachedAtMs: null,
        finalProjectorHeadReachedAt: null,
      };
      report.reservations.push(sample);
      persist(options.outputPath, report);
      await observeUnsafe(report, options.outputPath, options.baseUrl, sample);
      previousCommitAtMs = commit.receivedAtMs;
    }

    const finalCohortSuid = report.reservations.at(-1).suid;
    const targets = tagTargets(roomId, room.suid, report.reservations);
    const finalDeadlineMs = report.reservations.at(-1).commit.receivedAtMs + SAFE_BOUND_MS;
    report.cohort = {
      finalSuid: finalCohortSuid,
      finalSuidCommitAtMs: report.reservations.at(-1).commit.receivedAtMs,
      finalSuidCommitAt: report.reservations.at(-1).commit.receivedAt,
      safeDeadlineMs: finalDeadlineMs,
      safeDeadline: iso(finalDeadlineMs),
      targets,
    };
    persist(options.outputPath, report);

    let finalTagStates = [];
    let finalHealth = null;
    for (;;) {
      finalHealth = await readHealth(report, options.outputPath, options.baseUrl, options.token, "cohort-health");
      await observePendingUnsafe(report, options.outputPath, options.baseUrl);
      finalTagStates = await readAllTagStates(report, options.outputPath, options.baseUrl, options.token, targets, finalHealth.observedAtMs);
      updateSampleReach(report, finalHealth, finalTagStates);
      if (allFinalProjectorsAtTarget(finalHealth, finalCohortSuid)) {
        for (const sample of report.reservations) {
          if (sample.finalProjectorHeadReachedAtMs === null) {
            sample.finalProjectorHeadReachedAtMs = finalHealth.observedAtMs;
            sample.finalProjectorHeadReachedAt = finalHealth.observedAt;
          }
        }
      }
      report.latestProjectorHeads = currentProjectorHeads(finalHealth);
      report.scheduledPolls = scheduledPolls(report.healthSnapshots);
      persist(options.outputPath, report);
      const allSamplesProjectors = report.reservations.every((sample) =>
        Object.values(sample.projectorHeadReachedAt).every((value) => value !== null));
      const allSamplesTags = report.reservations.every((sample) => sample.tagStateReachedAtMs !== null);
      const withinPerSampleBound = report.reservations.every((sample) =>
        sample.finalProjectorHeadReachedAtMs !== null &&
        sample.finalProjectorHeadReachedAtMs <= sample.commit.receivedAtMs + SAFE_BOUND_MS &&
        sample.tagStateReachedAtMs !== null &&
        sample.tagStateReachedAtMs <= sample.commit.receivedAtMs + SAFE_BOUND_MS);
      if (allFinalProjectorsAtTarget(finalHealth, finalCohortSuid) && allTagStatesAtTarget(finalTagStates, targets) && allSamplesProjectors && allSamplesTags && withinPerSampleBound) {
        report.proof = {
          status: "passed",
          completedAtMs: finalHealth.observedAtMs,
          completedAt: finalHealth.observedAt,
          finalProjectorHeads: currentProjectorHeads(finalHealth),
          finalTagStates: finalTagStates.map((state) => ({
            tagStateId: state.target.tagStateId,
            expectedSuid: state.target.expectedSuid,
            lastSortedUniqueId: state.lastSortedUniqueId,
            version: state.version,
            observedAtMs: state.observedAtMs,
            response: state.response,
          })),
          everyProjectorReachedFinalSuid: true,
          everyCohortTagReturnedCommittedVersion: true,
          within180Seconds: true,
        };
        break;
      }
      if (Date.now() >= finalDeadlineMs) {
        report.proof = {
          status: "failed-safe-bound",
          completedAtMs: finalHealth.observedAtMs,
          completedAt: finalHealth.observedAt,
          finalProjectorHeads: currentProjectorHeads(finalHealth),
          finalTagStates: finalTagStates.map((state) => ({
            tagStateId: state.target.tagStateId,
            expectedSuid: state.target.expectedSuid,
            lastSortedUniqueId: state.lastSortedUniqueId,
            version: state.version,
            observedAtMs: state.observedAtMs,
            ok: state.ok,
          })),
          everyProjectorReachedFinalSuid: allFinalProjectorsAtTarget(finalHealth, finalCohortSuid),
          everyCohortTagReturnedCommittedVersion: allTagStatesAtTarget(finalTagStates, targets),
          within180Seconds: false,
        };
        break;
      }
      await sleep(2_000);
    }
    report.scheduledPolls = scheduledPolls(report.healthSnapshots);
    finaliseTiming(report);
    report.finishedAtMs = Date.now();
    report.finishedAt = iso(report.finishedAtMs);
    report.status = report.proof.status === "passed" ? "completed" : "failed";
    persist(options.outputPath, report);
    return report;
  } catch (error) {
    report.scheduledPolls = scheduledPolls(report.healthSnapshots);
    finaliseTiming(report);
    report.finishedAtMs = Date.now();
    report.finishedAt = iso(report.finishedAtMs);
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    persist(options.outputPath, report);
    throw error;
  }
}

const tokenFile = required("--token-file", argument("--token-file", process.env.G53_CONFORMANCE_TOKEN_FILE));
const token = readFileSync(tokenFile, "utf8").trim();
if (token.length === 0) throw new Error("conformance token file is empty");
const outputPath = resolve(required("--report", argument("--report", ".artifacts/sdt-g61-w148-public-cohort.json")));
const options = {
  baseUrl: required("--base-url", argument("--base-url", process.env.G61_BASE_URL)).replace(/\/$/, ""),
  token,
  serviceId: required("--service-id", argument("--service-id", "sekiban-dcb-meeting-room-cloudflare-only")),
  sourceHead: required("--source-head", argument("--source-head", "")),
  count: Number(argument("--count", "10")),
  outputPath,
  deployment: {
    worker: "sekiban-dcb-meeting-room-cloudflare-only",
    config: "samples/meeting-room/wrangler.cloudflare-only.jsonc",
    queueConsumerDeploymentWasPartiallyUpdated: true,
    queueApiErrorCode: 10013,
    exactWorkerVersion: "00e992de-296c-41f5-aa1c-983a7cd7f931",
    exactDeployment: "9caa533e-97b7-453b-8a49-ff1026c259d5",
    annotation: "SDT-G61 W148 exact 0eb83959732afe7b868fd24c34eadb2035fc9100",
    trafficPercent: 100,
  },
};
if (!Number.isSafeInteger(options.count) || options.count < 10) throw new Error("--count must be an integer >= 10");

run(options).then((report) => {
  process.stdout.write(`${JSON.stringify({ task: report.task, status: report.status, runId: report.runId, output: outputPath, proof: report.proof })}\n`);
  if (report.status !== "completed") process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

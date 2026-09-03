#!/usr/bin/env node
/**
 * SDT-G58 deployed safe-lane witness.
 *
 * `--mode paced` is one coherent setup-room plus >=10 paced reservation
 * cohort. `--mode single` is AC6's one-reservation smoke witness. The
 * delegated-proof continuation adds `--continue-after-unsafe` for the paced
 * cohort or `--record-unsafe-only` for the single witness: the unchanged
 * 5,000 ms unsafe disposition is recorded as pass/miss, while later list
 * visibility is observation-only. Live projector heads and tag state are
 * recorded as AC5 observations; head convergence belongs to SDT-G61. The
 * only credential is read from the private conformance-token file in memory;
 * no bearer value is logged or persisted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SERVICE_ID = "sekiban-dcb-meeting-room-cloudflare-only";
const SAFE_EXTRA_MS = 120_000;
const SAFE_ACCEPTANCE_MS = 180_000;
const UNSAFE_BOUND_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SUID = /^\d{30}$/;

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

function positiveInteger(name, value, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function compareSuid(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function atLeast(actual, expected) {
  return typeof actual === "string" && actual.length > 0 && compareSuid(actual, expected) >= 0;
}

function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("nearest-rank requires a non-empty sample");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function writeReport(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Persist a cohort checkpoint while the request receipt is still the only
 * newly-known fact.  The deployed witness can stop at any subsequent health
 * or visibility read, so an accepted command must never exist only in the
 * in-memory report.
 */
function persistReport(options, report) {
  if (typeof options.reportPath === "string" && options.reportPath.length > 0) {
    report.persistedCoverageHistory = persistedCoverageHistory(report.healthSnapshots);
    writeReport(options.reportPath, report);
  }
}

function commandSuid(body) {
  const response = body !== null && typeof body === "object" && body.response !== null && typeof body.response === "object"
    ? body.response
    : body;
  const events = response !== null && typeof response === "object" && Array.isArray(response.writtenEvents)
    ? response.writtenEvents
    : [];
  const suid = events[0]?.sortableUniqueIdValue;
  if (typeof suid !== "string" || !SUID.test(suid)) throw new Error("accepted command omitted a 30-digit sortableUniqueIdValue");
  return suid;
}

function listItems(body) {
  if (body === null || typeof body !== "object" || typeof body.itemsJson !== "string") {
    throw new Error("reservation list response omitted itemsJson");
  }
  const items = JSON.parse(body.itemsJson);
  if (!Array.isArray(items)) throw new Error("reservation list itemsJson was not an array");
  return items;
}

function healthSummary(body, receivedAtMs) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("read-health returned a non-object response");
  const coverage = body.coverage;
  const coverageHistory = body.coverageHistory;
  const lag = body.lag;
  const materializedViews = body.materializedViews;
  const liveProjections = body.liveProjections;
  if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) throw new Error("read-health omitted coverage");
  if (!Array.isArray(coverageHistory)) throw new Error("read-health omitted coverageHistory");
  if (lag === null || typeof lag !== "object" || Array.isArray(lag)) throw new Error("read-health omitted lag");
  if (!Array.isArray(materializedViews) || !Array.isArray(liveProjections)) throw new Error("read-health omitted MV or projection state");
  if (typeof lag.safeWindowMs !== "number" || !Number.isFinite(lag.safeWindowMs)) throw new Error("read-health omitted numeric safeWindowMs");
  return {
    receivedAtMs,
    coverage: {
      kind: typeof coverage.kind === "string" ? coverage.kind : "unknown",
      reason: coverage.reason === null || coverage.reason === undefined ? null : String(coverage.reason),
      partitionTag: coverage.partitionTag === null || coverage.partitionTag === undefined ? null : String(coverage.partitionTag),
      frontierSuid: typeof coverage.frontierSuid === "string" && coverage.frontierSuid.length > 0 ? coverage.frontierSuid : null,
      observedAt: typeof coverage.observedAt === "number" ? coverage.observedAt : null,
    },
    coverageHistory: coverageHistory.map((entry) => ({
      tickId: typeof entry?.tickId === "string" ? entry.tickId : "",
      kind: typeof entry?.kind === "string" ? entry.kind : "unknown",
      reason: entry?.reason === null || entry?.reason === undefined ? null : String(entry.reason),
      partitionTag: entry?.partitionTag === null || entry?.partitionTag === undefined ? null : String(entry.partitionTag),
      frontierSuid: typeof entry?.frontierSuid === "string" && entry.frontierSuid.length > 0 ? entry.frontierSuid : null,
      observedAt: typeof entry?.observedAt === "number" ? entry.observedAt : null,
    })),
    lag: {
      estimateMs: typeof lag.estimateMs === "number" ? lag.estimateMs : null,
      observedAt: typeof lag.observedAt === "number" ? lag.observedAt : null,
      decayedMs: typeof lag.decayedMs === "number" ? lag.decayedMs : null,
      safeWindowMs: lag.safeWindowMs,
      ceilingExceeded: lag.ceilingExceeded === true,
    },
    materializedViews: materializedViews.map((view) => ({
      viewId: typeof view?.viewId === "string" ? view.viewId : "",
      generation: typeof view?.generation === "number" ? view.generation : null,
      safeHead: typeof view?.safeHead === "string" ? view.safeHead : "",
      safeHeadAgeMs: typeof view?.safeHeadAgeMs === "number" ? view.safeHeadAgeMs : null,
      unsafeRows: typeof view?.unsafeRows === "number" ? view.unsafeRows : null,
      unsafeReceipts: typeof view?.unsafeReceipts === "number" ? view.unsafeReceipts : null,
    })),
    liveProjections: liveProjections.map((projection) => ({
      projectorId: typeof projection?.projectorId === "string" ? projection.projectorId : "",
      head: typeof projection?.head === "string" ? projection.head : "",
      headAgeMs: typeof projection?.headAgeMs === "number" ? projection.headAgeMs : null,
      lastPollAt: typeof projection?.lastPollAt === "number" ? projection.lastPollAt : null,
      pollStatus: typeof projection?.pollStatus === "string" ? projection.pollStatus : "never-invoked",
      pollReason: projection?.pollReason === null || projection?.pollReason === undefined ? null : String(projection.pollReason),
    })),
    globalHead: typeof body.globalHead === "string" ? body.globalHead : "",
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const startedAtMs = Date.now();
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const receivedAtMs = Date.now();
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { code: "non_json_response" }; }
  return {
    status: response.status,
    body,
    receivedAtMs,
    elapsedMs: receivedAtMs - startedAtMs,
    cfRay: response.headers.get("cf-ray"),
  };
}

function authenticatedHeaders(token, contentType = false) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(contentType ? { "content-type": "application/json" } : {}),
  };
}

async function readHealth(options) {
  const result = await requestJson(options.baseUrl, "/conformance/v1/read-health", {
    headers: authenticatedHeaders(options.token),
  });
  if (result.status !== 200) throw new Error(`read-health failed HTTP ${result.status}`);
  return { ...healthSummary(result.body, result.receivedAtMs), cfRay: result.cfRay, responseMs: result.elapsedMs };
}

async function projectionLag(options, tagStateId) {
  const result = await requestJson(
    options.baseUrl,
    `/conformance/v1/internal/projection/lag?tagStateId=${encodeURIComponent(tagStateId)}`,
    { headers: authenticatedHeaders(options.token) },
  );
  if (result.status !== 200 || result.body === null || typeof result.body !== "object" || Array.isArray(result.body)) {
    throw new Error(`projection-lag ${tagStateId} failed HTTP ${result.status}`);
  }
  return {
    tagStateId,
    checkpointSuid: typeof result.body.checkpointSuid === "string" ? result.body.checkpointSuid : "",
    headSuid: typeof result.body.headSuid === "string" ? result.body.headSuid : "",
    behindEvents: typeof result.body.behindEvents === "number" ? result.body.behindEvents : null,
    safeWindowMs: typeof result.body.safeWindowMs === "number" ? result.body.safeWindowMs : null,
    responseMs: result.elapsedMs,
    cfRay: result.cfRay,
  };
}

async function tagState(options, tagStateId) {
  const result = await requestJson(options.baseUrl, "/conformance/v1/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: authenticatedHeaders(options.token, true),
    body: JSON.stringify({ tagStateId }),
  });
  if (result.status !== 200 || result.body === null || typeof result.body !== "object" || Array.isArray(result.body)) {
    throw new Error(`tag-state ${tagStateId} failed HTTP ${result.status}`);
  }
  return {
    tagStateId,
    lastSortedUniqueId: typeof result.body.lastSortedUniqueId === "string" ? result.body.lastSortedUniqueId : "",
    version: typeof result.body.version === "number" ? result.body.version : null,
    responseMs: result.elapsedMs,
    cfRay: result.cfRay,
  };
}

async function readUnsafeObservation(options, reservationId, startedAtMs, observations) {
  const first = await requestJson(options.baseUrl, "/api/read/reservations?pageNumber=1&pageSize=100&newestFirst=true", {
    headers: { accept: "application/json" },
  });
  if (first.status !== 200) throw new Error(`unsafe list failed HTTP ${first.status}`);
  const totalCount = Number(first.body?.totalCount);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error("unsafe list omitted totalCount");
  const pages = Math.max(1, Math.ceil(totalCount / 100));
  const results = [first];
  for (let page = 2; page <= pages; page += 1) {
    results.push(await requestJson(options.baseUrl, `/api/read/reservations?pageNumber=${page}&pageSize=100&newestFirst=true`, {
      headers: { accept: "application/json" },
    }));
  }
  const items = results.flatMap((entry) => entry.status === 200 ? listItems(entry.body) : []);
  const visible = items.some((item) => item !== null && typeof item === "object" && item.reservationId === reservationId);
  const receivedAtMs = results.at(-1).receivedAtMs;
  const elapsedMs = receivedAtMs - startedAtMs;
  const observation = {
    atMs: receivedAtMs,
    elapsedMs,
    pageCount: pages,
    totalCount,
    itemCount: items.length,
    visible,
    readHead: typeof first.body?.readHead === "string" ? first.body.readHead : null,
    cfRay: first.cfRay,
  };
  observations.push(observation);
  return { visible, receivedAtMs, elapsedMs, observation };
}

async function waitForUnsafe(options, reservationId) {
  const startedAtMs = Date.now();
  const observations = [];
  for (;;) {
    const result = await readUnsafeObservation(options, reservationId, startedAtMs, observations);
    if (result.elapsedMs >= UNSAFE_BOUND_MS) {
      if (result.visible && result.elapsedMs === UNSAFE_BOUND_MS) {
        return { disposition: "pass", firstVisibleAtMs: result.receivedAtMs, elapsedMs: result.elapsedMs, observations };
      }
      if (options.continueAfterUnsafe) {
        return {
          disposition: "miss",
          boundMs: UNSAFE_BOUND_MS,
          boundExceededAtMs: result.receivedAtMs,
          elapsedMs: result.elapsedMs,
          firstVisibleAtMs: null,
          eventualFirstVisibleAtMs: result.visible ? result.receivedAtMs : null,
          observations,
        };
      }
      if (options.recordUnsafeOnly) {
        return {
          disposition: "miss",
          boundMs: UNSAFE_BOUND_MS,
          boundExceededAtMs: result.receivedAtMs,
          elapsedMs: result.elapsedMs,
          firstVisibleAtMs: null,
          eventualFirstVisibleAtMs: result.visible ? result.receivedAtMs : null,
          observations,
        };
      }
      throw new Error(`unsafe reservation ${reservationId} was not visible within ${UNSAFE_BOUND_MS}ms`);
    }
    if (result.visible) return { disposition: "pass", firstVisibleAtMs: result.receivedAtMs, elapsedMs: result.elapsedMs, observations };
    await sleep(Math.min(options.pollMs, Math.max(1, UNSAFE_BOUND_MS - result.elapsedMs)));
  }
}

async function waitForPacedCommit(options, report, notBeforeMs) {
  while (Date.now() < notBeforeMs) {
    const health = await readHealth(options);
    report.healthSnapshots.push(health);
    persistReport(options, report);
    const remainingMs = notBeforeMs - Date.now();
    if (remainingMs > 0) await sleep(Math.min(options.pollMs, remainingMs));
  }
}

function safeHead(health, viewId) {
  return health.materializedViews.find((view) => view.viewId === viewId)?.safeHead ?? "";
}

/**
 * Keep the append-only rows returned by the deployed health surface alongside
 * the safe heads observed at each read.  This is refreshed before every
 * checkpoint write so a tick is durable in the raw receipt as soon as it is
 * first observed.
 */
function persistedCoverageHistory(snapshots) {
  const rows = new Map();
  for (const snapshot of snapshots ?? []) {
    for (const entry of snapshot?.coverageHistory ?? []) {
      if (typeof entry?.tickId !== "string" || entry.tickId.length === 0) continue;
      const safeHeadObservation = {
        receivedAtMs: snapshot.receivedAtMs,
        roomSafeHead: safeHead(snapshot, "RoomProjector"),
        reservationSafeHead: safeHead(snapshot, "ReservationProjector"),
      };
      const current = rows.get(entry.tickId);
      if (current === undefined) {
        rows.set(entry.tickId, {
          tickId: entry.tickId,
          kind: entry.kind,
          reason: entry.reason,
          partitionTag: entry.partitionTag,
          frontierSuid: entry.frontierSuid,
          observedAt: entry.observedAt,
          observedAtIso: Number.isSafeInteger(entry.observedAt) ? new Date(entry.observedAt).toISOString() : null,
          safeHeadObservations: [safeHeadObservation],
          roomSafeHead: safeHeadObservation.roomSafeHead,
          reservationSafeHead: safeHeadObservation.reservationSafeHead,
        });
      } else {
        current.safeHeadObservations.push(safeHeadObservation);
        current.roomSafeHead = safeHeadObservation.roomSafeHead;
        current.reservationSafeHead = safeHeadObservation.reservationSafeHead;
      }
    }
  }
  return [...rows.values()].sort((left, right) => {
    if (left.observedAt !== right.observedAt) return (left.observedAt ?? 0) - (right.observedAt ?? 0);
    return left.tickId.localeCompare(right.tickId);
  });
}

function slowAttribution(sample, snapshots) {
  if (sample.safe.commitToSafeMs <= sample.safeWindowAtCommitMs + 60_000) return { kind: "within_safe_window_plus_60s" };
  const during = snapshots.filter((snapshot) => snapshot.receivedAtMs >= sample.commit.receivedAtMs && snapshot.receivedAtMs <= sample.safe.reachedAtMs);
  const blocked = during.find((snapshot) => snapshot.coverage.kind === "BLOCK/UNSETTLED");
  if (blocked !== undefined) return { kind: "coverage_BLOCK", reason: blocked.coverage.reason, partitionTag: blocked.coverage.partitionTag };
  const lag = during.find((snapshot) => snapshot.lag.safeWindowMs > 20_000 || snapshot.lag.ceilingExceeded);
  if (lag !== undefined) return { kind: "lag_estimate_window", safeWindowMs: lag.lag.safeWindowMs, ceilingExceeded: lag.lag.ceilingExceeded };
  const coverageTicks = new Set(during.map((snapshot) => snapshot.coverage.observedAt).filter((value) => value !== null));
  if (coverageTicks.size === 0) return { kind: "cron_not_firing", reason: "no scheduled coverage observation during the slow interval" };
  return { kind: "follow_stopping_at_unsafe_event", reason: "scheduled coverage advanced but the safe head remained below the target" };
}

function scheduledPollLifecycle(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const observedAt = snapshot?.coverage?.observedAt;
    if (!Number.isSafeInteger(observedAt)) continue;
    const rows = groups.get(observedAt) ?? [];
    rows.push(snapshot);
    groups.set(observedAt, rows);
  }
  return [...groups.entries()].map(([observedAt, rows]) => {
    const latest = rows.at(-1);
    const projectors = (latest?.liveProjections ?? []).map((projection) => ({
      projectorId: projection.projectorId,
      attemptedAt: projection.lastPollAt,
      outcome: projection.pollStatus,
      reason: projection.pollReason,
    }));
    return {
      observedAt,
      observedAtIso: new Date(observedAt).toISOString(),
      httpSamples: rows.length,
      coverage: {
        kind: latest?.coverage?.kind ?? "unknown",
        reason: latest?.coverage?.reason ?? null,
        partitionTag: latest?.coverage?.partitionTag ?? null,
        frontierSuid: latest?.coverage?.frontierSuid ?? null,
      },
      persistedCoverageHistory: latest?.coverageHistory ?? [],
      snapshots: rows.map((snapshot) => ({
        receivedAtMs: snapshot.receivedAtMs,
        receivedAtIso: new Date(snapshot.receivedAtMs).toISOString(),
        coverage: {
          kind: snapshot.coverage.kind,
          reason: snapshot.coverage.reason,
          partitionTag: snapshot.coverage.partitionTag,
          frontierSuid: snapshot.coverage.frontierSuid,
          observedAt: snapshot.coverage.observedAt,
        },
        coverageHistory: snapshot.coverageHistory,
        lag: {
          decayedMs: snapshot.lag.decayedMs,
          safeWindowMs: snapshot.lag.safeWindowMs,
          ceilingExceeded: snapshot.lag.ceilingExceeded,
        },
        projectors: snapshot.liveProjections.map((projection) => ({
          projectorId: projection.projectorId,
          attemptedAt: projection.lastPollAt,
          outcome: projection.pollStatus,
          reason: projection.pollReason,
        })),
      })),
      projectors,
      allRegisteredProjectorsObserved: ["RoomProjector", "ReservationProjector"].every((projectorId) =>
        projectors.some((row) => row.projectorId === projectorId && Number.isSafeInteger(row.attemptedAt))),
    };
  });
}

function projectionTargets(roomId, reservations) {
  return [
    { projectorId: "RoomProjector", tagStateId: `room:${roomId}:RoomProjector` },
    ...reservations.map((reservation) => ({ projectorId: "ReservationProjector", tagStateId: `reservation:${reservation.reservationId}:ReservationProjector` })),
  ];
}

function projectorAttemptTelemetry(health) {
  return (health?.liveProjections ?? []).map((projection) => ({
    projectorId: projection.projectorId,
    lastPollAt: projection.lastPollAt,
    pollStatus: projection.pollStatus,
    pollReason: projection.pollReason,
  }));
}

function attemptTelemetryAdvanced(current, baseline) {
  return ["RoomProjector", "ReservationProjector"].every((projectorId) => {
    const now = current?.find((projection) => projection.projectorId === projectorId);
    const before = baseline?.find((projection) => projection.projectorId === projectorId);
    if (!Number.isSafeInteger(now?.lastPollAt)) return false;
    return !Number.isSafeInteger(before?.lastPollAt) || now.lastPollAt > before.lastPollAt;
  });
}

async function waitForSafeAndLive(options, report, targets) {
  const pending = new Set(report.reservations.map((reservation) => reservation.reservationId));
  const lastSuid = report.reservations.at(-1).suid;
  const safeDeadlineFor = (reservation) => options.mode === "paced"
    ? reservation.commit.receivedAtMs + SAFE_ACCEPTANCE_MS
    : reservation.commit.receivedAtMs + reservation.safeWindowAtCommitMs + SAFE_EXTRA_MS;
  const finalDeadlineMs = Math.max(...report.reservations.map(safeDeadlineFor));
  let lastHealth = null;
  for (;;) {
    if (options.continueAfterUnsafe || options.recordUnsafeOnly) {
      for (const reservation of report.reservations) {
        const unsafe = reservation.unsafe;
        if (unsafe?.disposition !== "miss" || unsafe.eventualFirstVisibleAtMs !== null) continue;
        const eventual = await readUnsafeObservation(options, reservation.reservationId, reservation.commit.receivedAtMs, unsafe.observations);
        if (eventual.visible) {
          unsafe.eventualFirstVisibleAtMs = eventual.receivedAtMs;
          unsafe.eventualCommitToUnsafeMs = eventual.receivedAtMs - reservation.commit.receivedAtMs;
        }
      }
      persistReport(options, report);
    }
    const health = await readHealth(options);
    lastHealth = health;
    report.healthSnapshots.push(health);
    persistReport(options, report);
    const reservationSafeHead = safeHead(health, "ReservationProjector");
    for (const reservation of report.reservations) {
      if (!pending.has(reservation.reservationId) || !atLeast(reservationSafeHead, reservation.suid)) continue;
      reservation.safe = {
        reachedAtMs: health.receivedAtMs,
        commitToSafeMs: health.receivedAtMs - reservation.commit.receivedAtMs,
        safeHead: reservationSafeHead,
      };
      pending.delete(reservation.reservationId);
    }
    if (pending.size === 0) {
      const telemetryAdvanced = attemptTelemetryAdvanced(health.liveProjections, report.attemptTelemetryBaseline);
      if (options.mode === "single" && !telemetryAdvanced) {
        report.liveProjectionObservation = {
          targetSuid: lastSuid,
          health: health.liveProjections,
          attemptTelemetryBaseline: report.attemptTelemetryBaseline,
          attemptTelemetryAdvanced: false,
          projectionLag: null,
          tagState: null,
          headConvergence: "observed-only; projector head advancement and committed tag-state belong to SDT-G61",
        };
      } else {
        const lags = await Promise.all(targets.map((target) => projectionLag(options, target.tagStateId)));
        const states = await Promise.all(targets.map((target) => tagState(options, target.tagStateId)));
        report.liveProjectionObservation = {
          targetSuid: lastSuid,
          health: health.liveProjections,
          attemptTelemetryBaseline: report.attemptTelemetryBaseline,
          attemptTelemetryAdvanced: telemetryAdvanced,
          projectionLag: lags,
          tagState: states,
          headConvergence: "observed-only; projector head advancement and committed tag-state belong to SDT-G61",
          allProjectionRowsAtTarget: lags.every((lag) => atLeast(lag.checkpointSuid, lastSuid) && lag.behindEvents === 0),
          allTagStatesAtTarget: states.every((state) => atLeast(state.lastSortedUniqueId, lastSuid)),
          aggregateHeadsAtTarget: health.liveProjections.every((projection) => atLeast(projection.head, lastSuid)),
        };
        persistReport(options, report);
        if (options.mode !== "single" || telemetryAdvanced) return;
      }
      persistReport(options, report);
    }
    const overdue = report.reservations.find((reservation) => health.receivedAtMs > safeDeadlineFor(reservation) && reservation.safe === undefined);
    if (overdue !== undefined || health.receivedAtMs > finalDeadlineMs) {
      const target = overdue?.suid ?? lastSuid;
      const error = new Error(options.mode === "paced"
        ? `safe lane did not reach ${target} within the 180000ms paced safe acceptance line`
        : `safe lane or projector attempt telemetry did not reach ${target} by safeWindowMs + ${SAFE_EXTRA_MS}ms`);
      error.lastHealth = lastHealth;
      throw error;
    }
    await sleep(options.pollMs);
  }
}

async function acceptedCommand(options, path, body) {
  const result = await requestJson(options.baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (result.status !== 200) throw new Error(`${path} failed HTTP ${result.status}`);
  return { ...result, suid: commandSuid(result.body) };
}

async function run(options) {
  const runId = crypto.randomUUID();
  const pacedCount = options.mode === "paced" ? options.pacedCount : 1;
  const startedAtMs = Date.now();
  const report = {
    schema: "sdt-g58-safe-lane-e2e/v1",
    task: "SDT-G58",
    mode: options.mode,
    runId,
    baseUrl: options.baseUrl,
    serviceId: options.serviceId,
    startedAt: new Date(startedAtMs).toISOString(),
    contract: {
      pacedReservationCommits: pacedCount,
      paceMs: options.mode === "paced" ? options.paceMs : null,
      unsafeBoundMs: UNSAFE_BOUND_MS,
      unsafeProof: options.continueAfterUnsafe
        ? "delegated to SDT-G60: retain each 5000ms pass/miss and observe eventual visibility without reclassification"
        : options.recordUnsafeOnly
          ? "recorded only for SDT-G60: retain each 5000ms pass/miss and observe eventual visibility without reclassification"
          : "asserted by the unchanged 5000ms bound",
      safeDeadline: "health.safeWindowMs + 120000ms",
      pacedSafeAcceptanceMs: options.mode === "paced" ? SAFE_ACCEPTANCE_MS : null,
      liveProjectionProof: "observed only; head advancement and committed tag-state belong to SDT-G61",
      conformanceAuthorization: "Bearer supplied from protected G53_CONFORMANCE_TOKEN_FILE; value not persisted",
    },
    healthSnapshots: [],
    reservations: [],
  };
  try {
    report.healthBefore = await readHealth(options);
    report.healthSnapshots.push(report.healthBefore);
    report.attemptTelemetryBaseline = projectorAttemptTelemetry(report.healthBefore);
    const roomId = `g58-room-${runId.slice(0, 12)}`;
    const room = await acceptedCommand(options, "/api/commands/create-room", { roomId, name: `SDT-G58 ${options.mode}` });
    report.setupRoom = { roomId, suid: room.suid, commit: { receivedAtMs: room.receivedAtMs, responseMs: room.elapsedMs, cfRay: room.cfRay } };
    persistReport(options, report);

    let previousCommitAtMs = room.receivedAtMs;
    for (let ordinal = 1; ordinal <= pacedCount; ordinal += 1) {
      const notBeforeMs = previousCommitAtMs + (options.mode === "paced" ? options.paceMs : 0);
      if (Date.now() < notBeforeMs) await waitForPacedCommit(options, report, notBeforeMs);
      const reservationId = `g58-reservation-${runId.slice(0, 12)}-${ordinal}`;
      const commit = await acceptedCommand(options, "/api/commands/reserve-room", {
        roomId,
        reservationId,
        userId: `g58-user-${ordinal}`,
      });
      // This checkpoint is intentionally before health/unsafe polling.  If a
      // visibility bound fails, the accepted receipt and SUID remain durable
      // evidence instead of disappearing with the thrown request.
      const reservation = {
        ordinal,
        reservationId,
        suid: commit.suid,
        commit: { receivedAtMs: commit.receivedAtMs, responseMs: commit.elapsedMs, cfRay: commit.cfRay },
        pacing: { previousCommitToThisCommitMs: commit.receivedAtMs - previousCommitAtMs, requiredMs: options.mode === "paced" ? options.paceMs : 0 },
        unsafe: null,
        safeWindowAtCommitMs: null,
      };
      report.reservations.push(reservation);
      persistReport(options, report);
      const healthAtCommit = await readHealth(options);
      report.healthSnapshots.push(healthAtCommit);
      reservation.safeWindowAtCommitMs = healthAtCommit.lag.safeWindowMs;
      persistReport(options, report);
      const unsafe = await waitForUnsafe(options, reservationId);
      if (unsafe.disposition === "miss") {
        reservation.unsafe = {
          disposition: "miss",
          boundMs: unsafe.boundMs,
          boundExceededAtMs: unsafe.boundExceededAtMs,
          firstVisibleAtMs: null,
          eventualFirstVisibleAtMs: unsafe.eventualFirstVisibleAtMs ?? null,
          eventualCommitToUnsafeMs: unsafe.eventualFirstVisibleAtMs === null || unsafe.eventualFirstVisibleAtMs === undefined
            ? null
            : unsafe.eventualFirstVisibleAtMs - commit.receivedAtMs,
          observations: unsafe.observations,
        };
      } else {
        reservation.unsafe = {
          disposition: "pass",
          firstVisibleAtMs: unsafe.firstVisibleAtMs,
          commitToUnsafeMs: unsafe.firstVisibleAtMs - commit.receivedAtMs,
          observations: unsafe.observations,
        };
      }
      persistReport(options, report);
      previousCommitAtMs = commit.receivedAtMs;
    }

    await waitForSafeAndLive(options, report, projectionTargets(roomId, report.reservations));
    report.scheduledPollLifecycle = scheduledPollLifecycle(report.healthSnapshots);
    for (const reservation of report.reservations) reservation.slowGateAttribution = slowAttribution(reservation, report.healthSnapshots);
    const safeSamples = report.reservations.map((reservation) => reservation.safe.commitToSafeMs);
    const unsafeSamples = report.reservations
      .map((reservation) => reservation.unsafe)
      .filter((unsafe) => unsafe?.disposition === "pass" && typeof unsafe.commitToUnsafeMs === "number")
      .map((unsafe) => unsafe.commitToUnsafeMs);
    report.unsafeDisposition = {
      owner: options.continueAfterUnsafe || options.recordUnsafeOnly ? "SDT-G60" : "SDT-G58",
      boundMs: UNSAFE_BOUND_MS,
      rule: "A visibility after the 5000ms bound remains a miss and is observation-only; it is never reclassified as an unsafe pass.",
      rows: report.reservations.map((reservation) => ({
        reservationId: reservation.reservationId,
        suid: reservation.suid,
        disposition: reservation.unsafe.disposition,
        boundMs: reservation.unsafe.boundMs ?? UNSAFE_BOUND_MS,
        boundExceededAtMs: reservation.unsafe.boundExceededAtMs ?? null,
        firstVisibleAtMs: reservation.unsafe.firstVisibleAtMs ?? null,
        eventualFirstVisibleAtMs: reservation.unsafe.eventualFirstVisibleAtMs ?? null,
        eventualCommitToUnsafeMs: reservation.unsafe.eventualCommitToUnsafeMs ?? null,
      })),
    };
    report.timing = {
      unsafe: {
        n: report.reservations.length,
        passN: unsafeSamples.length,
        missN: report.reservations.filter((reservation) => reservation.unsafe?.disposition === "miss").length,
        censoredN: report.reservations.filter((reservation) => reservation.unsafe?.eventualFirstVisibleAtMs === null).length,
        p50Ms: unsafeSamples.length > 0 ? nearestRank(unsafeSamples, 0.5) : null,
        p95Ms: unsafeSamples.length > 0 ? nearestRank(unsafeSamples, 0.95) : null,
      },
      safe: { n: safeSamples.length, p50Ms: nearestRank(safeSamples, 0.5), p95Ms: nearestRank(safeSamples, 0.95) },
    };
    report.healthAfter = await readHealth(options);
    report.healthSnapshots.push(report.healthAfter);
    report.finishedAt = new Date().toISOString();
    report.status = "completed";
    return report;
  } catch (caught) {
    report.scheduledPollLifecycle = scheduledPollLifecycle(report.healthSnapshots);
    report.finishedAt = new Date().toISOString();
    report.status = "failed";
    report.failure = caught instanceof Error ? caught.message : String(caught);
    if (caught !== null && typeof caught === "object" && "lastHealth" in caught) report.lastHealth = caught.lastHealth;
    throw Object.assign(caught instanceof Error ? caught : new Error(String(caught)), { report });
  }
}

function selfTest() {
  if (compareSuid("0002", "00010") <= 0) throw new Error("SUID ordering self-test failed");
  if (nearestRank([1, 2, 3, 4], 0.95) !== 4) throw new Error("nearest-rank p95 self-test failed");
  const normal = slowAttribution({ safe: { commitToSafeMs: 20_000 }, safeWindowAtCommitMs: 20_000 }, []);
  if (normal.kind !== "within_safe_window_plus_60s") throw new Error("normal timing attribution self-test failed");
  const blocked = slowAttribution({ safe: { commitToSafeMs: 90_001, reachedAtMs: 2 }, commit: { receivedAtMs: 0 }, safeWindowAtCommitMs: 20_000 }, [{ receivedAtMs: 1, coverage: { kind: "BLOCK/UNSETTLED", reason: "gap", partitionTag: "room:1", observedAt: 1 }, lag: { safeWindowMs: 20_000, ceilingExceeded: false } }]);
  if (blocked.kind !== "coverage_BLOCK") throw new Error("BLOCK attribution self-test failed");
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-safe-lane-e2e" })}\n`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const mode = required("--mode", argument("--mode", "single"));
  if (mode !== "single" && mode !== "paced") throw new Error("--mode must be single or paced");
  const continueAfterUnsafe = process.argv.includes("--continue-after-unsafe");
  if (continueAfterUnsafe && mode !== "paced") throw new Error("--continue-after-unsafe requires --mode paced");
  const recordUnsafeOnly = process.argv.includes("--record-unsafe-only");
  const tokenFile = required("--token-file", argument("--token-file", process.env.G53_CONFORMANCE_TOKEN_FILE));
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length === 0) throw new Error("protected conformance token file is empty");
  const options = {
    mode,
    baseUrl: required("--base-url", argument("--base-url", process.env.G58_BASE_URL)).replace(/\/$/, ""),
    serviceId: required("--service-id", argument("--service-id", process.env.G58_SERVICE_ID ?? DEFAULT_SERVICE_ID)),
    token,
    reportPath: undefined,
    pacedCount: positiveInteger("--paced-count", argument("--paced-count", "10"), 10),
    paceMs: positiveInteger("--pace-ms", argument("--pace-ms", "10000"), 10_000),
    pollMs: positiveInteger("--poll-ms", argument("--poll-ms", "2000"), 100),
    continueAfterUnsafe,
    recordUnsafeOnly,
  };
  const output = resolve(required("--report", argument("--report", options.mode === "paced" ? ".artifacts/sdt-g58-paced-cohort.json" : ".artifacts/sdt-g58-e2e.json")));
  options.reportPath = output;
  run(options).then((report) => {
    writeReport(output, report);
    process.stdout.write(`${JSON.stringify({ task: report.task, mode: report.mode, status: report.status, runId: report.runId, output })}\n`);
  }).catch((error) => {
    if (error?.report !== undefined) {
      writeReport(output, error.report);
      const lastSnapshot = error.report.lastHealth ?? error.report.healthSnapshots?.at(-1);
      if (lastSnapshot !== undefined) process.stderr.write(`last health snapshot: ${JSON.stringify(lastSnapshot)}\n`);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * Read-only SDT-G58 AC1/AC5 deployed checkpoint witness. It never sends an
 * app command or asks projection-lag to poll: cron must establish the proof.
 * The conformance bearer is held only in memory and is absent from output.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 30_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function values(name) {
  const result = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
      result.push(value);
    }
  }
  return result;
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
  return typeof actual === "string" && actual.length > 0 && typeof expected === "string" && expected.length > 0 && compareSuid(actual, expected) >= 0;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function writeReport(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function requestJson(baseUrl, path, token, init = {}) {
  const startedAtMs = Date.now();
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const receivedAtMs = Date.now();
  let body;
  try { body = await response.json(); } catch { body = { code: "non_json_response" }; }
  return { status: response.status, body, receivedAtMs, responseMs: receivedAtMs - startedAtMs, cfRay: response.headers.get("cf-ray") };
}

function healthSummary(result) {
  if (result.status !== 200 || result.body === null || typeof result.body !== "object" || Array.isArray(result.body)) {
    throw new Error(`read-health failed HTTP ${result.status}`);
  }
  const body = result.body;
  if (!Array.isArray(body.materializedViews) || !Array.isArray(body.liveProjections) || body.coverage === null || typeof body.coverage !== "object" || body.lag === null || typeof body.lag !== "object") {
    throw new Error("read-health omitted an AC1 section");
  }
  return {
    receivedAtMs: result.receivedAtMs,
    responseMs: result.responseMs,
    cfRay: result.cfRay,
    materializedViews: body.materializedViews.map((view) => ({
      viewId: typeof view?.viewId === "string" ? view.viewId : "",
      generation: typeof view?.generation === "number" ? view.generation : null,
      safeHead: typeof view?.safeHead === "string" ? view.safeHead : "",
      safeHeadAgeMs: typeof view?.safeHeadAgeMs === "number" ? view.safeHeadAgeMs : null,
      unsafeRows: typeof view?.unsafeRows === "number" ? view.unsafeRows : null,
      unsafeReceipts: typeof view?.unsafeReceipts === "number" ? view.unsafeReceipts : null,
    })),
    coverage: {
      kind: typeof body.coverage.kind === "string" ? body.coverage.kind : "",
      reason: body.coverage.reason === null || body.coverage.reason === undefined ? null : String(body.coverage.reason),
      partitionTag: body.coverage.partitionTag === null || body.coverage.partitionTag === undefined ? null : String(body.coverage.partitionTag),
      observedAt: typeof body.coverage.observedAt === "number" ? body.coverage.observedAt : null,
    },
    lag: {
      estimateMs: typeof body.lag.estimateMs === "number" ? body.lag.estimateMs : null,
      observedAt: typeof body.lag.observedAt === "number" ? body.lag.observedAt : null,
      decayedMs: typeof body.lag.decayedMs === "number" ? body.lag.decayedMs : null,
      safeWindowMs: typeof body.lag.safeWindowMs === "number" ? body.lag.safeWindowMs : null,
      ceilingExceeded: body.lag.ceilingExceeded === true,
    },
    liveProjections: body.liveProjections.map((projection) => ({
      projectorId: typeof projection?.projectorId === "string" ? projection.projectorId : "",
      head: typeof projection?.head === "string" ? projection.head : "",
      headAgeMs: typeof projection?.headAgeMs === "number" ? projection.headAgeMs : null,
      lastPollAt: typeof projection?.lastPollAt === "number" ? projection.lastPollAt : null,
    })),
    globalHead: typeof body.globalHead === "string" ? body.globalHead : "",
  };
}

async function proofForTag(options, target) {
  const { tagStateId } = target;
  const lag = await requestJson(options.baseUrl, `/conformance/v1/internal/projection/lag?tagStateId=${encodeURIComponent(tagStateId)}`, options.token);
  if (lag.status !== 200 || lag.body === null || typeof lag.body !== "object" || Array.isArray(lag.body)) {
    throw new Error(`projection-lag ${tagStateId} failed HTTP ${lag.status}`);
  }
  const state = await requestJson(options.baseUrl, "/conformance/v1/api/sekiban/serialized/tag-state", options.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tagStateId }),
  });
  if (state.status !== 200 || state.body === null || typeof state.body !== "object" || Array.isArray(state.body)) {
    throw new Error(`tag-state ${tagStateId} failed HTTP ${state.status}`);
  }
  return {
    tagStateId,
    expectedTagHead: target.expectedTagHead,
    projectionLag: {
      checkpointSuid: typeof lag.body.checkpointSuid === "string" ? lag.body.checkpointSuid : "",
      headSuid: typeof lag.body.headSuid === "string" ? lag.body.headSuid : "",
      behindEvents: typeof lag.body.behindEvents === "number" ? lag.body.behindEvents : null,
      safeWindowMs: typeof lag.body.safeWindowMs === "number" ? lag.body.safeWindowMs : null,
      cfRay: lag.cfRay,
    },
    tagState: {
      lastSortedUniqueId: typeof state.body.lastSortedUniqueId === "string" ? state.body.lastSortedUniqueId : "",
      version: typeof state.body.version === "number" ? state.body.version : null,
      cfRay: state.cfRay,
    },
  };
}

function complete(health, perTag) {
  const expectedProjectors = ["RoomProjector", "ReservationProjector"];
  const head = health.globalHead;
  // One post-deploy scheduled disposition is the AC1 proof. Waiting for a
  // second tick would turn this read-only checkpoint into timing evidence.
  const coverageObserved = health.coverage.observedAt !== null;
  const viewsReady = expectedProjectors.every((projectorId) => health.materializedViews.some((view) => view.viewId === projectorId && view.generation !== null));
  const projectionsReady = head.length > 0 && expectedProjectors.every((projectorId) => health.liveProjections.some((projection) => projection.projectorId === projectorId && atLeast(projection.head, head)));
  // A live projection checkpoint advances through the service's whole ordered
  // source, while a tag-state response is intentionally scoped to one tag.
  // Comparing that tag-state to the global head would falsely call a healthy
  // older room state stale. The exact tagged D1 head is the correct AC5
  // committed-version oracle.
  const tagsReady = head.length > 0 && perTag.every((entry) =>
    atLeast(entry.projectionLag.checkpointSuid, head) &&
    entry.projectionLag.behindEvents === 0 &&
    atLeast(entry.projectionLag.headSuid, entry.expectedTagHead) &&
    atLeast(entry.tagState.lastSortedUniqueId, entry.expectedTagHead),
  );
  return { coverageObserved, viewsReady, projectionsReady, tagsReady, passed: coverageObserved && viewsReady && projectionsReady && tagsReady };
}

async function run(options) {
  const report = {
    schema: "sdt-g58-ac1-ac5-readproof/v1",
    task: "SDT-G58",
    sourceCommit: options.sourceCommit,
    deployedVersionId: options.deployedVersionId,
    baseUrl: options.baseUrl,
    startedAt: new Date().toISOString(),
    contract: {
      noAppRequests: true,
      noProjectionPollQuery: true,
      authorization: "Bearer supplied from protected G53_CONFORMANCE_TOKEN_FILE; value not persisted",
    },
    tagTargets: options.tagTargets,
    healthSnapshots: [],
  };
  try {
    const deadline = Date.now() + options.windowMs;
    for (;;) {
      const health = healthSummary(await requestJson(options.baseUrl, "/conformance/v1/read-health", options.token));
      const perTag = await Promise.all(options.tagTargets.map((target) => proofForTag(options, target)));
      const readiness = complete(health, perTag);
      report.healthSnapshots.push(health);
      report.latest = { health, perTag, readiness };
      if (readiness.passed) {
        report.status = "completed";
        report.finishedAt = new Date().toISOString();
        return report;
      }
      if (Date.now() >= deadline) throw new Error("AC1/AC5 read-only proof did not reach the required deployed state within the bounded window");
      await sleep(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
    }
  } catch (caught) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.failure = caught instanceof Error ? caught.message : String(caught);
    throw Object.assign(caught instanceof Error ? caught : new Error(String(caught)), { report });
  }
}

function selfTest() {
  if (!atLeast("0002", "00010")) throw new Error("SUID comparison self-test failed");
  const state = complete({
    coverage: { observedAt: 2 },
    globalHead: "0002",
    materializedViews: [{ viewId: "RoomProjector", generation: 1 }, { viewId: "ReservationProjector", generation: 1 }],
    liveProjections: [{ projectorId: "RoomProjector", head: "0002" }, { projectorId: "ReservationProjector", head: "0002" }],
  }, [{ expectedTagHead: "0001", projectionLag: { checkpointSuid: "0002", headSuid: "0001", behindEvents: 0 }, tagState: { lastSortedUniqueId: "0001" } }]);
  if (!state.passed) throw new Error("read-proof success self-test failed");
  const behind = complete({
    coverage: { observedAt: 2 },
    globalHead: "0002",
    materializedViews: [{ viewId: "RoomProjector", generation: 1 }, { viewId: "ReservationProjector", generation: 1 }],
    liveProjections: [{ projectorId: "RoomProjector", head: "0002" }, { projectorId: "ReservationProjector", head: "0002" }],
  }, [{ expectedTagHead: "0002", projectionLag: { checkpointSuid: "0002", headSuid: "0001", behindEvents: 0 }, tagState: { lastSortedUniqueId: "0001" } }]);
  if (behind.tagsReady) throw new Error("tag-head mismatch self-test mutation unexpectedly passed");
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-ac1-ac5-readproof" })}\n`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const tokenFile = required("--token-file", argument("--token-file", process.env.G53_CONFORMANCE_TOKEN_FILE));
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length === 0) throw new Error("protected conformance token file is empty");
  const tagStateIds = values("--tag-state-id");
  const tagHeads = values("--tag-head");
  if (tagStateIds.length < 2 || tagHeads.length !== tagStateIds.length) {
    throw new Error("provide paired RoomProjector/ReservationProjector --tag-state-id and --tag-head values");
  }
  const options = {
    baseUrl: required("--base-url", argument("--base-url", process.env.G58_BASE_URL)).replace(/\/$/, ""),
    token,
    tagTargets: tagStateIds.map((tagStateId, index) => ({ tagStateId, expectedTagHead: tagHeads[index] })),
    sourceCommit: required("--source-commit", argument("--source-commit")),
    deployedVersionId: required("--version-id", argument("--version-id")),
    windowMs: positiveInteger("--window-ms", argument("--window-ms", "150000"), 1),
    pollMs: positiveInteger("--poll-ms", argument("--poll-ms", "10000"), 100),
  };
  const output = resolve(required("--report", argument("--report", ".artifacts/ci-local/g58-readproof.json")));
  run(options).then((report) => {
    writeReport(output, report);
    process.stdout.write(`${JSON.stringify({ task: report.task, status: report.status, output })}\n`);
  }).catch((error) => {
    if (error?.report !== undefined) writeReport(output, error.report);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

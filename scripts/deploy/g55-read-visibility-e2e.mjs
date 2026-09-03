/**
 * One coherent SDT-G55 deployed read-visibility cohort.  It sends exactly one
 * room command followed by three reservation commands, proves each app-route
 * unsafe list observation within five seconds, and uses the active D1 MV
 * checkpoint as the safe-head oracle without requiring a conformance secret.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_SERVICE_ID = "sekiban-dcb-meeting-room-cloudflare-only";
const DEFAULT_MV_DATABASE = "sekiban-dcb-meeting-room-cloudflare-mv";
const DEFAULT_CONFIG = "samples/meeting-room/wrangler.cloudflare-only.jsonc";
const DEFAULT_WRANGLER = "./node_modules/.bin/wrangler";
const SORTABLE_UNIQUE_ID = /^\d{30}$/;

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

function commandSuid(body) {
  const response = body !== null && typeof body === "object" && body.response !== null && typeof body.response === "object"
    ? body.response
    : body;
  const events = response !== null && typeof response === "object" && Array.isArray(response.writtenEvents)
    ? response.writtenEvents
    : [];
  const value = events[0]?.sortableUniqueIdValue;
  if (typeof value !== "string" || !SORTABLE_UNIQUE_ID.test(value)) throw new Error("commit response omitted a 30-digit sortableUniqueIdValue");
  return value;
}

function listItems(body) {
  if (body === null || typeof body !== "object" || typeof body.itemsJson !== "string") throw new Error("reservation list response omitted itemsJson");
  const value = JSON.parse(body.itemsJson);
  if (!Array.isArray(value)) throw new Error("reservation list itemsJson was not an array");
  return value;
}

async function requestJson(baseUrl, path, options = {}) {
  const startedAtMs = Date.now();
  const response = await fetch(new URL(path, baseUrl), options);
  const receivedAtMs = Date.now();
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { rawText: text }; }
  return {
    status: response.status,
    body,
    elapsedMs: receivedAtMs - startedAtMs,
    receivedAtMs,
    cfRay: response.headers.get("cf-ray"),
  };
}

function d1Rows(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = d1Rows(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value.results)) return value.results;
    for (const entry of Object.values(value)) {
      const found = d1Rows(entry);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function d1Execute({ wrangler, config, database, command }) {
  const result = spawnSync(wrangler, ["d1", "execute", database, "--remote", "--config", config, "--command", command, "--json"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    const error = new Error(`remote D1 query failed: ${result.error?.message ?? `exit ${String(result.status)}`}`);
    error.wrangler = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? null };
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch {
    const error = new Error("remote D1 query did not emit JSON");
    error.wrangler = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? null };
    throw error;
  }
  const rows = d1Rows(parsed);
  if (rows === undefined) throw new Error("remote D1 JSON did not contain result rows");
  return rows;
}

function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function activeSafeHead(options) {
  const rows = d1Execute({
    ...options,
    command: `SELECT instance.last_suid FROM mv_active_generations active JOIN mv_instances instance ON instance.service_id = active.service_id AND instance.view_id = active.view_id AND instance.generation = active.generation WHERE active.service_id = ${sqlText(options.serviceId)} AND active.view_id = 'ReservationProjector' LIMIT 1`,
  });
  const value = rows[0]?.last_suid;
  return typeof value === "string" ? value : "";
}

function unsafeD1Facts(options) {
  const rows = d1Execute({
    ...options,
    command: `SELECT (SELECT COUNT(*) FROM mv_unsafe_receipts WHERE service_id = ${sqlText(options.serviceId)} AND view_id = 'ReservationProjector') AS receipts, (SELECT COUNT(*) FROM mv_unsafe_rows WHERE service_id = ${sqlText(options.serviceId)} AND view_id = 'ReservationProjector') AS rows`,
  });
  const first = rows[0] ?? {};
  return { receipts: Number(first.receipts ?? 0), rows: Number(first.rows ?? 0) };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reportPath(path) {
  return resolve(path);
}

function writeReport(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForUnsafe({ baseUrl, reservationId, timeoutMs, pollMs }) {
  const startedAtMs = Date.now();
  const observations = [];
  for (;;) {
    const result = await requestJson(baseUrl, "/api/read/reservations?pageNumber=1&pageSize=100&newestFirst=true", {
      headers: { accept: "application/json" },
    });
    const items = result.status === 200 ? listItems(result.body) : [];
    const readHead = typeof result.body?.readHead === "string" ? result.body.readHead : null;
    const visible = items.some((item) => item !== null && typeof item === "object" && item.reservationId === reservationId);
    observations.push({
      atMs: result.receivedAtMs,
      elapsedMs: result.receivedAtMs - startedAtMs,
      status: result.status,
      readHead,
      itemCount: items.length,
      visible,
      cfRay: result.cfRay,
    });
    if (visible) {
      return { firstVisibleAtMs: result.receivedAtMs, elapsedMs: result.receivedAtMs - startedAtMs, readHead, observations };
    }
    if (result.receivedAtMs - startedAtMs >= timeoutMs) {
      throw new Error(`unsafe list did not contain ${reservationId} within ${timeoutMs}ms`);
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAtMs))));
  }
}

async function run(options) {
  const runId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const report = {
    schema: "sdt-g55-read-visibility-e2e/v1",
    task: "SDT-G55",
    runId,
    baseUrl: options.baseUrl,
    serviceId: options.serviceId,
    startedAt: new Date(startedAtMs).toISOString(),
    contract: {
      commands: "one room plus exactly three reservations",
      unsafeBoundMs: options.unsafeTimeoutMs,
      safeHeadSource: "remote D1 mv_active_generations ReservationProjector last_suid",
      listRoute: "GET /api/read/reservations (app route opts into consistency:unsafe)",
    },
    d1Before: unsafeD1Facts(options),
    reservations: [],
  };
  try {
    const roomId = `g55-room-${runId.slice(0, 12)}`;
    const room = await requestJson(options.baseUrl, "/api/commands/create-room", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ roomId, name: "SDT-G55 read visibility" }),
    });
    if (room.status !== 200) throw new Error(`create-room failed HTTP ${room.status}`);
    report.room = { roomId, status: room.status, commitResponseMs: room.elapsedMs, suid: commandSuid(room.body), cfRay: room.cfRay };

    for (let index = 1; index <= 3; index += 1) {
      const reservationId = `g55-reservation-${runId.slice(0, 12)}-${index}`;
      const commit = await requestJson(options.baseUrl, "/api/commands/reserve-room", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ roomId, reservationId, userId: `g55-user-${index}` }),
      });
      if (commit.status !== 200) throw new Error(`reserve-room ${reservationId} failed HTTP ${commit.status}`);
      const suid = commandSuid(commit.body);
      const unsafe = await waitForUnsafe({
        baseUrl: options.baseUrl,
        reservationId,
        timeoutMs: options.unsafeTimeoutMs,
        pollMs: options.pollMs,
      });
      report.reservations.push({
        reservationId,
        suid,
        commit: { status: commit.status, responseMs: commit.elapsedMs, receivedAtMs: commit.receivedAtMs, cfRay: commit.cfRay },
        unsafe: {
          firstVisibleAtMs: unsafe.firstVisibleAtMs,
          commitToVisibleMs: unsafe.firstVisibleAtMs - commit.receivedAtMs,
          pollElapsedMs: unsafe.elapsedMs,
          readHead: unsafe.readHead,
          observations: unsafe.observations,
        },
      });
    }

    const pending = new Set(report.reservations.map((entry) => entry.reservationId));
    const safeHeadObservations = [];
    while (pending.size > 0) {
      const observedAtMs = Date.now();
      const head = activeSafeHead(options);
      safeHeadObservations.push({ observedAtMs, head });
      for (const reservation of report.reservations) {
        if (!pending.has(reservation.reservationId)) continue;
        if (head !== "" && compareSuid(head, reservation.suid) >= 0) {
          reservation.safe = { reachedAtMs: observedAtMs, commitToSafeHeadMs: observedAtMs - reservation.commit.receivedAtMs, readHead: head };
          pending.delete(reservation.reservationId);
        } else if (observedAtMs - reservation.commit.receivedAtMs > options.safeTimeoutMs) {
          throw new Error(`safe head did not reach ${reservation.suid} for ${reservation.reservationId} within ${options.safeTimeoutMs}ms`);
        }
      }
      if (pending.size > 0) await sleep(options.pollMs);
    }
    report.safeHeadObservations = safeHeadObservations;
    report.d1After = unsafeD1Facts(options);
    report.finishedAt = new Date().toISOString();
    report.status = "completed";
    return report;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    if (error !== null && typeof error === "object" && "wrangler" in error) report.wranglerFailure = error.wrangler;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  }
}

function selfTest() {
  if (compareSuid("0002", "00010") <= 0) throw new Error("SUID byte ordering self-test failed");
  if (commandSuid({ writtenEvents: [{ sortableUniqueIdValue: "012345678901234567890123456789" }] }) !== "012345678901234567890123456789") throw new Error("commit SUID self-test failed");
  if (listItems({ itemsJson: '[{"reservationId":"one"}]' }).length !== 1) throw new Error("list parser self-test failed");
  const rows = d1Rows([{ success: true, result: [{ results: [{ last_suid: "x" }] }] }]);
  if (rows?.[0]?.last_suid !== "x") throw new Error("D1 parser self-test failed");
  process.stdout.write(`${JSON.stringify({ selfTest: "g55-read-visibility-e2e" })}\n`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const output = reportPath(required("--report", argument("--report", ".artifacts/sdt-g55-read-visibility-e2e.json")));
  const options = {
    baseUrl: required("--base-url", argument("--base-url", process.env.G55_BASE_URL)).replace(/\/$/, ""),
    serviceId: required("--service-id", argument("--service-id", process.env.G55_SERVICE_ID ?? DEFAULT_SERVICE_ID)),
    wrangler: required("--wrangler", argument("--wrangler", DEFAULT_WRANGLER)),
    config: required("--config", argument("--config", DEFAULT_CONFIG)),
    database: required("--database", argument("--database", DEFAULT_MV_DATABASE)),
    unsafeTimeoutMs: positiveInteger("--unsafe-timeout-ms", argument("--unsafe-timeout-ms", "5000"), 1),
    safeTimeoutMs: positiveInteger("--safe-timeout-ms", argument("--safe-timeout-ms", "120000"), 1),
    pollMs: positiveInteger("--poll-ms", argument("--poll-ms", "250"), 1),
  };
  run(options).then((report) => {
    writeReport(output, report);
    process.stdout.write(`${JSON.stringify({ task: report.task, status: report.status, runId: report.runId, output })}\n`);
  }).catch((error) => {
    const report = error?.report;
    if (report !== undefined) writeReport(output, report);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

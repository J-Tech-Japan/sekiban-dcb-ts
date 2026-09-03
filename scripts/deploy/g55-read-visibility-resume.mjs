/**
 * Read-only continuation for a stopped SDT-G55 cohort.
 *
 * It deliberately sends no Worker request and performs exactly one remote D1
 * query. The original cohort provides the before receipt; this query records
 * its after receipt and determines whether every original reservation has
 * reached the active ReservationProjector safe head.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function compareSuid(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
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

function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function writeReport(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readCohort(path) {
  let input;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read cohort artifact ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (input?.schema !== "sdt-g55-read-visibility-e2e/v1" || input.task !== "SDT-G55") {
    throw new Error("input is not an SDT-G55 cohort artifact");
  }
  if (typeof input.runId !== "string" || input.runId.length === 0) throw new Error("cohort runId is missing");
  if (!Array.isArray(input.reservations) || input.reservations.length !== 3) {
    throw new Error("resume requires exactly the preserved three-reservation cohort");
  }
  if (input.reservations.some((reservation) => typeof reservation?.reservationId !== "string" || !SORTABLE_UNIQUE_ID.test(reservation?.suid ?? "") || !Number.isSafeInteger(reservation?.commit?.receivedAtMs))) {
    throw new Error("cohort reservation identity or commit timing is malformed");
  }
  if (typeof input?.d1Before?.receipts !== "number" || typeof input?.d1Before?.rows !== "number") {
    throw new Error("cohort before-D1 receipt is missing");
  }
  return input;
}

function d1Command(serviceId) {
  return `SELECT (SELECT COUNT(*) FROM mv_unsafe_receipts WHERE service_id = ${sqlText(serviceId)} AND view_id = 'ReservationProjector') AS receipts, (SELECT COUNT(*) FROM mv_unsafe_rows WHERE service_id = ${sqlText(serviceId)} AND view_id = 'ReservationProjector') AS rows, (SELECT instance.last_suid FROM mv_active_generations active JOIN mv_instances instance ON instance.service_id = active.service_id AND instance.view_id = active.view_id AND instance.generation = active.generation WHERE active.service_id = ${sqlText(serviceId)} AND active.view_id = 'ReservationProjector' LIMIT 1) AS safe_head`;
}

function executeOnce(options, command, attemptedAtUtc) {
  const args = ["d1", "execute", options.database, "--remote", "--config", options.config, "--command", command, "--json"];
  const result = spawnSync(options.wrangler, args, { encoding: "utf8", shell: false });
  const invocation = {
    executable: options.wrangler,
    args,
    attemptedAtUtc,
  };
  if (result.error !== undefined || result.status !== 0) {
    const error = new Error(`remote D1 query failed: ${result.error?.message ?? `exit ${String(result.status)}`}`);
    error.invocation = invocation;
    error.wrangler = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? null };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    const error = new Error("remote D1 query did not emit JSON");
    error.invocation = invocation;
    error.wrangler = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? null };
    throw error;
  }
  const rows = d1Rows(parsed);
  if (rows === undefined || rows.length !== 1) throw new Error("remote D1 JSON did not contain exactly one result row");
  const row = rows[0] ?? {};
  const safeHead = typeof row.safe_head === "string" ? row.safe_head : "";
  if (!SORTABLE_UNIQUE_ID.test(safeHead)) throw new Error("remote D1 active ReservationProjector safe head was absent or malformed");
  return {
    invocation,
    after: {
      receipts: Number(row.receipts ?? 0),
      rows: Number(row.rows ?? 0),
      activeSafeHead: safeHead,
    },
  };
}

function completeReservations(cohort, safeHead, observedAtMs, observedAtUtc) {
  return cohort.reservations.map((reservation) => ({
    reservationId: reservation.reservationId,
    suid: reservation.suid,
    commitReceivedAtMs: reservation.commit.receivedAtMs,
    priorUnsafe: {
      commitToVisibleMs: reservation.unsafe?.commitToVisibleMs ?? null,
      firstVisibleAtMs: reservation.unsafe?.firstVisibleAtMs ?? null,
    },
    safe: compareSuid(safeHead, reservation.suid) >= 0
      ? {
          reachedAtMs: observedAtMs,
          observedAtUtc,
          commitToSafeHeadMs: observedAtMs - reservation.commit.receivedAtMs,
          readHead: safeHead,
          source: "one resumed remote D1 active-generation query against the preserved cohort",
        }
      : null,
  }));
}

function run(options) {
  const cohort = readCohort(options.input);
  const report = {
    schema: "sdt-g55-read-visibility-resume/v1",
    task: "SDT-G55",
    runId: cohort.runId,
    inputArtifact: options.input,
    status: "started",
    contract: {
      appRequestsSent: 0,
      d1QueriesAttempted: 1,
      beforeReceiptSource: "preserved original cohort artifact",
      afterReceiptSource: "one resumed remote D1 query",
      safeHeadSource: "mv_active_generations ReservationProjector last_suid",
    },
    d1Before: cohort.d1Before,
  };
  const attemptedAtUtc = new Date().toISOString();
  try {
    const result = executeOnce(options, d1Command(options.serviceId), attemptedAtUtc);
    const observedAtMs = Date.now();
    const observedAtUtc = new Date(observedAtMs).toISOString();
    report.d1After = result.after;
    report.invocation = result.invocation;
    report.reservations = completeReservations(cohort, result.after.activeSafeHead, observedAtMs, observedAtUtc);
    report.thirdSafe = report.reservations[2].safe;
    if (report.thirdSafe === null) throw new Error(`active safe head ${result.after.activeSafeHead} has not reached preserved third reservation ${cohort.reservations[2].suid}`);
    report.finishedAt = observedAtUtc;
    report.status = "completed";
    return report;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    if (error !== null && typeof error === "object" && "invocation" in error) report.invocation = error.invocation;
    if (error !== null && typeof error === "object" && "wrangler" in error) report.wranglerFailure = error.wrangler;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  }
}

function selfTest() {
  if (compareSuid("0002", "00010") <= 0) throw new Error("SUID byte-order self-test failed");
  const cohort = {
    reservations: [{ reservationId: "one", suid: "012345678901234567890123456789", commit: { receivedAtMs: 100 }, unsafe: { commitToVisibleMs: 7 } }],
  };
  const complete = completeReservations(cohort, "012345678901234567890123456790", 130, "2026-09-03T00:00:00.000Z");
  if (complete[0]?.safe?.commitToSafeHeadMs !== 30) throw new Error("safe-head completion self-test failed");
  const missing = completeReservations(cohort, "012345678901234567890123456788", 130, "2026-09-03T00:00:00.000Z");
  if (missing[0]?.safe !== null) throw new Error("safe-head below-SUID mutant was incorrectly accepted");
  const rows = d1Rows([{ result: [{ results: [{ safe_head: "x" }] }] }]);
  if (rows?.[0]?.safe_head !== "x") throw new Error("D1 parser self-test failed");
  process.stdout.write(`${JSON.stringify({ selfTest: "g55-read-visibility-resume" })}\n`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const output = resolve(required("--output", argument("--output", ".artifacts/sdt-g55-oauth-resume.json")));
  const options = {
    input: resolve(required("--input", argument("--input", ".artifacts/sdt-g55-packaging-repair-e2e.json"))),
    serviceId: required("--service-id", argument("--service-id", DEFAULT_SERVICE_ID)),
    wrangler: required("--wrangler", argument("--wrangler", DEFAULT_WRANGLER)),
    config: required("--config", argument("--config", DEFAULT_CONFIG)),
    database: required("--database", argument("--database", DEFAULT_MV_DATABASE)),
  };
  try {
    const report = run(options);
    writeReport(output, report);
    process.stdout.write(`${JSON.stringify({ task: report.task, status: report.status, runId: report.runId, output })}\n`);
  } catch (error) {
    if (error?.report !== undefined) writeReport(output, error.report);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

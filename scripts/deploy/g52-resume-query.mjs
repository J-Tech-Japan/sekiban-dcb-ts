#!/usr/bin/env node
/**
 * SDT-G52 one-time recovery and CLI.
 *
 * Generic paced-cohort state and exact-ray resume logic lives in the ordinary
 * module; this deploy module retains the historical recovery and CLI surface.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  TASK,
  SAMPLE_COUNT,
  COHORT_REQUEST_COUNT,
  RESUME_THRESHOLD,
  RESUME_BOUND_MS,
  RESUME_INTERVAL_MS,
  PACED_FALLBACK_DELAY_MS,
  WINDOWED_RESUME_QUERY_SCOPE,
  createPacedResumeState,
  capturePacedCohort,
  resumeExactRayQuery,
  readResumeState,
  fail,
  required,
  finiteTimestamp,
  mutableCopy,
  sourceCommit,
  runId,
} from "../g52-resume-query.mjs";
export {
  TASK,
  RESUME_STATE_SCHEMA,
  SAMPLE_COUNT,
  COHORT_REQUEST_COUNT,
  RESUME_THRESHOLD,
  RESUME_BOUND_MS,
  RESUME_INTERVAL_MS,
  PACED_SAMPLE_INTERVAL_MS,
  PACED_FALLBACK_DELAY_MS,
  SNAPSHOT_PER_HOP_ROWS,
  WINDOWED_RESUME_QUERY_SCOPE,
  createPacedResumeState,
  capturePacedCohort,
  resumeExactRayQuery,
  readResumeState,
} from "../g52-resume-query.mjs";
import { querySnapshotLogsInFixedWindow } from "../g30-trace-export.mjs";

const W68_RECOVERY_SCHEMA = "sdt-g52-w68-recovery/v1";
const W68_FIXED_WINDOW = Object.freeze({
  from: Date.parse("2026-09-02T07:55:00.000Z"),
  to: Date.parse("2026-09-02T08:35:00.000Z"),
  cohortStartedAtMs: Date.parse("2026-09-02T08:19:13.824Z"),
});
export { W68_RECOVERY_SCHEMA, W68_FIXED_WINDOW };

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
function persistedStatePath(path) {
  return resolve(process.cwd(), required("--state", path));
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function stateSummary(state) {
  const latest = state?.resume?.latest;
  return Object.freeze({
    schema: state?.schema,
    cohortKind: state?.cohortKind,
    runId: state?.runId,
    lifecycle: state?.resume?.lifecycle,
    acceptedSampleRequests: Array.isArray(state?.ledger) ? state.ledger.length : null,
    schemaCompleteSampleRoots: latest?.schemaCompleteSampleRoots ?? 0,
    retainedSampleRoots: latest?.retainedSampleRoots ?? 0,
    nextQueryAt: Number.isFinite(state?.resume?.nextQueryAtMs) ? new Date(state.resume.nextQueryAtMs).toISOString() : null,
    deadlineAt: Number.isFinite(state?.resume?.deadlineAtMs) ? new Date(state.resume.deadlineAtMs).toISOString() : null,
  });
}

export function createW68RecoveryState(now = Date.now) {
  const observedAtMs = finiteTimestamp("now", now());
  return Object.freeze({
    schema: W68_RECOVERY_SCHEMA,
    task: TASK,
    cohortKind: "w68-burst",
    deployed: Object.freeze({
      versionId: "38921aad-9faf-4ac5-bdfd-1348d7214422",
      sourceCommit: "6db728122fefc410e7d9639d62302bb107df13be",
    }),
    cohortWindow: W68_FIXED_WINDOW,
    sent: Object.freeze({ invocationRequests: COHORT_REQUEST_COUNT, acceptedSampleRequests: SAMPLE_COUNT }),
    authoritativeAddendumObservation: Object.freeze({
      source: "SDT-G52-RESUME-QUERY-ADDENDUM-W70 direct query of the fixed W68 window",
      retainedWorkerInvocations: 2,
      retainedDoAppendInvocations: 1,
      retainedDoAllocateInvocations: 1,
      retainedSpans: 870,
      retainedG44SourceObligationInvocations: 89,
    }),
    ledgerAvailability: "unrecoverable-full-ray-set: W68 wrote its artifact only after the bounded receipt and therefore persisted no client CF-Ray ledger",
    observedAtMs,
    resumed: Object.freeze({ exactRaySet: Object.freeze([]), retainedSnapshotReceipts: Object.freeze([]) }),
  });
}

export async function recoverW68SnapshotWindow({
  state: originalState,
  accountId,
  token,
  template,
  now = Date.now,
  queryFixedWindow = querySnapshotLogsInFixedWindow,
}) {
  if (originalState?.schema !== W68_RECOVERY_SCHEMA) fail("W68 recovery state schema is invalid");
  const state = mutableCopy(originalState);
  const queriedAtMs = finiteTimestamp("now", now());
  const result = await queryFixedWindow({
    accountId: required("accountId", accountId),
    token: required("observability token", token),
    template: structuredClone(template),
    fromMs: W68_FIXED_WINDOW.from,
    toMs: W68_FIXED_WINDOW.to,
  });
  state.observedAtMs = queriedAtMs;
  state.resumed = Object.freeze({
    queryScope: "one-time-authorized-fixed-W68-window",
    window: result.window,
    exactRaySet: Object.freeze(result.receipts.map((receipt) => receipt.requestId)),
    retainedSnapshotReceipts: result.receipts,
    retentionRatio: Object.freeze({
      invocationRoots: Object.freeze({ retained: result.receipts.length, sent: COHORT_REQUEST_COUNT }),
      snapshotRoots: Object.freeze({ retained: result.receipts.length, sent: COHORT_REQUEST_COUNT }),
    }),
    nextAction: "No additional W68 query is issued because the missing 49 client CF-Ray values were never persisted; do not substitute a time-nearest or new-request cohort.",
  });
  return Object.freeze(state);
}

/**
 * Make the timing decision durable without scheduling an unattended process.
 * A later implementation wake can execute the recorded start/resume commands
 * verbatim, while this wake remains honest about not having sent the paced
 * fallback before its two-hour gate.
 */
export function createPacedFallbackSchedule({ w68Recovery, pacedStatePath, now = Date.now }) {
  if (w68Recovery?.schema !== W68_RECOVERY_SCHEMA) fail("paced fallback schedule needs W68 recovery state");
  const observed = w68Recovery?.resumed?.retainedSnapshotReceipts;
  if (!Array.isArray(observed)) fail("W68 recovery state lacks retained snapshot receipts");
  const observedAtMs = finiteTimestamp("now", now());
  const fallbackAtMs = W68_FIXED_WINDOW.cohortStartedAtMs + PACED_FALLBACK_DELAY_MS;
  const boundedAtMs = W68_FIXED_WINDOW.cohortStartedAtMs + RESUME_BOUND_MS;
  const ready = observed.length < RESUME_THRESHOLD && observedAtMs >= fallbackAtMs;
  return Object.freeze({
    schema: "sdt-g52-resume-query-schedule/v1",
    task: TASK,
    generatedAtMs: observedAtMs,
    w68: Object.freeze({
      fixedWindow: W68_FIXED_WINDOW,
      retainedSnapshotRoots: observed.length,
      sentInvocationRequests: COHORT_REQUEST_COUNT,
      threshold: RESUME_THRESHOLD,
      exactFullRayLedger: "unavailable; never fabricate missing identities",
    }),
    pacedFallback: Object.freeze({
      allowedCohorts: 1,
      earliestStartAtMs: fallbackAtMs,
      "24hBoundAtMs": boundedAtMs,
      decision: ready ? "start-paced-now" : "wait-until-two-hour-gate",
      statePath: required("pacedStatePath", pacedStatePath),
      protocol: "one discarded accepted warm-up, then exactly 50 accepted commits at least 10000 ms apart; resume-query only the saved 51 CF-Ray values; no third cohort",
      startCommand: "env G50_OBSERVABILITY_TOKEN_FILE=/path/to/user/.config/sekiban-dcb/observability-token node scripts/deploy/g52-resume-query.mjs --mode start-paced --state .artifacts/ci-local/g52-paced-resume.json --base-url https://example.workers.dev --account-id REPLACE_WITH_ACCOUNT_ID --service-id sekiban-dcb-meeting-room-cloudflare-only --version-id 38921aad-9faf-4ac5-bdfd-1348d7214422 --source-commit 6db728122fefc410e7d9639d62302bb107df13be --run-id g52-w69-paced-20260902-01",
      resumeCommand: "env G50_OBSERVABILITY_TOKEN_FILE=/path/to/user/.config/sekiban-dcb/observability-token node scripts/deploy/g52-resume-query.mjs --mode resume --state .artifacts/ci-local/g52-paced-resume.json --account-id REPLACE_WITH_ACCOUNT_ID",
    }),
    runnerStatus: "interactive wake does not leave an unattended runner; the next exact action and immutable state path are persisted",
  });
}

function readObservabilityToken() {
  const path = required("G50_OBSERVABILITY_TOKEN_FILE", process.env.G50_OBSERVABILITY_TOKEN_FILE);
  if (!existsSync(path)) fail("G50_OBSERVABILITY_TOKEN_FILE does not exist");
  const token = readFileSync(path, "utf8").trim();
  if (token.length === 0) fail("G50_OBSERVABILITY_TOKEN_FILE is empty");
  return token;
}

function publicFailureClass(error) {
  // State artifacts are committed. Never preserve a provider error string
  // there because it can include request metadata or authorization material.
  return error instanceof Error && /telemetry query failed/.test(error.message)
    ? "telemetry-query-failed"
    : "resume-query-failed";
}

async function main() {
  const mode = required("--mode", argument("--mode"));
  const statePath = persistedStatePath(argument("--state", ".artifacts/sdt-g52-w69-resume-state.json"));
  if (mode === "schedule-paced-fallback") {
    const w68Path = resolve(process.cwd(), required("--w68-state", argument("--w68-state")));
    const w68Recovery = JSON.parse(readFileSync(w68Path, "utf8"));
    const schedule = createPacedFallbackSchedule({
      w68Recovery,
      pacedStatePath: argument("--paced-state", ".artifacts/ci-local/g52-paced-resume.json"),
    });
    writeJsonAtomically(statePath, schedule);
    process.stdout.write(`${JSON.stringify({ mode, decision: schedule.pacedFallback.decision, earliestStartAt: new Date(schedule.pacedFallback.earliestStartAtMs).toISOString(), state: statePath }, null, 2)}\n`);
    return;
  }
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const templatePath = argument("--query-template", "scripts/deploy/g37-observability-query.json");
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  const token = readObservabilityToken();

  if (mode === "recover-w68") {
    const initial = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : createW68RecoveryState();
    const state = await recoverW68SnapshotWindow({ state: initial, accountId, token, template });
    writeJsonAtomically(statePath, state);
    process.stdout.write(`${JSON.stringify({ mode, state: stateSummary(state), retainedW68Roots: state.resumed.retainedSnapshotReceipts.length }, null, 2)}\n`);
    return;
  }

  if (mode === "start-paced") {
    if (existsSync(statePath)) fail("paced state path already exists; a second paced cohort is forbidden");
    const initial = createPacedResumeState({
      baseUrl: required("--base-url", argument("--base-url", process.env.G52_BASE_URL)),
      accountId,
      serviceId: required("--service-id", argument("--service-id", process.env.SDT_SERVICE_ID)),
      versionId: required("--version-id", argument("--version-id", process.env.G52_VERSION_ID)),
      sourceCommit: sourceCommit(required("--source-commit", argument("--source-commit", process.env.G52_SOURCE_COMMIT))),
      runId: runId(argument("--run-id", `g52-w69-paced-${randomUUID().replaceAll("-", "").slice(0, 16)}`)),
    });
    const captured = await capturePacedCohort({ state: initial, persist: async (state) => writeJsonAtomically(statePath, state) });
    const queried = await resumeExactRayQuery({ state: captured, accountId, token, template });
    writeJsonAtomically(statePath, queried);
    process.stdout.write(`${JSON.stringify({ mode, state: stateSummary(queried) }, null, 2)}\n`);
    return;
  }

  if (mode === "resume") {
    const initial = readResumeState(statePath);
    try {
      const state = await resumeExactRayQuery({ state: initial, accountId, token, template });
      writeJsonAtomically(statePath, state);
      process.stdout.write(`${JSON.stringify({ mode, state: stateSummary(state) }, null, 2)}\n`);
    } catch (error) {
      const state = mutableCopy(initial);
      state.resume.queries.push(Object.freeze({
        attempt: state.resume.queries.length + 1,
        queriedAtMs: Date.now(),
        queryScope: WINDOWED_RESUME_QUERY_SCOPE,
        errorClass: publicFailureClass(error),
      }));
      state.resume.lifecycle = "resume-query-error";
      state.resume.nextQueryAtMs = Math.min(state.resume.deadlineAtMs, Date.now() + RESUME_INTERVAL_MS);
      writeJsonAtomically(statePath, state);
      throw error;
    }
    return;
  }

  fail("--mode must be recover-w68, schedule-paced-fallback, start-paced, or resume");
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

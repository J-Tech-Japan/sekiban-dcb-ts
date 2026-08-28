#!/usr/bin/env node
/** Read-only P0 source acquisition for the retained SDT-G37 final cohort. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  clientRequestIdByPlatformRayId,
  exportCohortTelemetry,
  normalizeTelemetryBundle,
} from "./g30-trace-export.mjs";
import { auditG42P0 } from "../g42-p0-audit.mjs";

function fail(message) {
  throw new Error(`g42-p0-export:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function boundedTemplate(template, ledger) {
  const query = structuredClone(object(template, "template"));
  const starts = ledger.map((row, index) => {
    if (typeof row?.startedAtMs !== "number" || !Number.isFinite(row.startedAtMs)) fail(`ledger[${index}].startedAtMs is invalid`);
    return row.startedAtMs;
  });
  const completed = ledger.map((row, index) => {
    if (typeof row?.completedAtMs !== "number" || !Number.isFinite(row.completedAtMs)) fail(`ledger[${index}].completedAtMs is invalid`);
    return row.completedAtMs;
  });
  query.timeframe = { from: Math.max(0, Math.min(...starts) - 60_000), to: Math.max(...completed) + 10 * 60_000 };
  return query;
}

function sourceDocument({ cohort, template, raw, bundle, error }) {
  const ledger = Array.isArray(cohort.ledger) ? cohort.ledger : [];
  const query = {
    request: {
      method: "POST",
      endpoint: "/accounts/{account}/workers/observability/telemetry/query",
      chain: "exact client cf-ray -> worker observation correlation -> S00 traceId -> trace and sdt.observe/v1 correlation queries",
      template,
      cohortIdentityCount: ledger.length,
      identityHandling: "The local source contains exact fixture CF-Ray IDs; committed audit output retains only ordinal/hash joins.",
    },
    response: raw === undefined
      ? { availability: "SOURCE_UNAVAILABLE", observedAt: new Date().toISOString(), errorClass: error }
      : { availability: "AVAILABLE", observedAt: new Date().toISOString(), rawEventCount: raw.events?.length ?? null, ...(error === undefined ? {} : { normalizationClass: error }) },
  };
  return {
    query,
    provider: {
      retention: {
        source: "Workers Logs retention is provider/config dependent and short (commonly 3 or 7 days); this read-only query records the actual availability rather than inferring retention from a missing join.",
        queryMode: "bounded exact cohort identities",
      },
      config: {
        worker: "sekiban-dcb-meeting-room-cloudflare-only",
        view: template.view,
        limit: template.limit,
        timeframe: template.timeframe,
      },
    },
    cohort: { sourceCommit: cohort.sourceCommit, ledger },
    ...(bundle === undefined ? {} : { telemetry: bundle }),
  };
}

async function main() {
  const cohort = JSON.parse(readFileSync(required("--cohort", argument("--cohort")), "utf8"));
  const ledger = Array.isArray(cohort?.ledger) ? cohort.ledger : undefined;
  if (ledger === undefined || ledger.length === 0) fail("cohort ledger is required");
  const template = boundedTemplate(JSON.parse(readFileSync(argument("--query-template", "scripts/deploy/g37-observability-query.json"), "utf8")), ledger);
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G30_OBSERVABILITY_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) fail("observability token file is empty");
  let raw;
  let bundle;
  let error;
  try {
    raw = await exportCohortTelemetry({ accountId, token, template, ledger });
    try {
      bundle = normalizeTelemetryBundle(raw, Date.now(), clientRequestIdByPlatformRayId(ledger));
    } catch (normalizationError) {
      // The provider answered, but a missing correlation/row is a PARTIAL
      // P0 join rather than a reason to create replacement traffic.
      bundle = { traces: [], observations: [] };
      error = normalizationError instanceof Error ? normalizationError.name : "normalization_error";
    }
  } catch (queryError) {
    error = queryError instanceof Error ? queryError.name : "query_error";
  }
  const audit = auditG42P0(sourceDocument({ cohort, template, raw, bundle, error }));
  const output = argument("--output", ".artifacts/SDT-G42-p0-audit.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outcome: audit.outcome, cohort: audit.cohort, output }, null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

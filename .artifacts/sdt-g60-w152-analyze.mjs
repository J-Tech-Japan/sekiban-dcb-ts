#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ORIGINAL_STAGES = [
  "command-receipt",
  "tag-append-committed",
  "outbox-obligation-written",
  "queue-send-returned",
  "consumer-invocation-started",
  "record-delivery-batch-committed",
  "first-unsafe-visible-read",
];
const STRIPPED_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function rowsOf(receipt) {
  return (receipt.parsed ?? []).flatMap((result) => Array.isArray(result?.results) ? result.results : []);
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function stats(values, totalN) {
  const valid = values.filter((value) => Number.isFinite(value)).map((value) => Math.round(value));
  return {
    n: valid.length,
    missingN: totalN - valid.length,
    p50Ms: nearestRank(valid, 0.5),
    p95Ms: nearestRank(valid, 0.95),
    minMs: valid.length === 0 ? null : Math.min(...valid),
    maxMs: valid.length === 0 ? null : Math.max(...valid),
    valuesMs: valid,
  };
}

function asNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function rowFor(rows, predicate) {
  return rows
    .filter(predicate)
    .sort((left, right) => Number(left.observed_at) - Number(right.observed_at))[0] ?? null;
}

const cohortPath = required("--cohort", argument("--cohort"));
const ledgerPath = required("--ledger", argument("--ledger"));
const mvPath = required("--mv", argument("--mv"));
const reportPath = resolve(required("--report", argument("--report")));
const cohort = readJson(cohortPath);
const ledger = readJson(ledgerPath);
const mv = readJson(mvPath);
const ledgerRows = rowsOf(ledger);
const mvRows = rowsOf(mv);
const samples = (cohort.reservations ?? []).map((sample) => {
  const event = sample?.commit?.body?.response?.writtenEvents?.[0];
  return {
    ordinal: sample?.ordinal ?? null,
    reservationId: sample?.reservationId ?? null,
    eventId: event?.id ?? null,
    suid: event?.sortableUniqueIdValue ?? sample?.suid ?? null,
    commitStartedAtMs: asNumber(sample?.commit?.startedAtMs),
    commitReceivedAtMs: asNumber(sample?.commit?.receivedAtMs),
    publicVisibilityMs: asNumber(sample?.visibility?.commitToFirstVisibilityMs),
    publicVisibleAtMs: asNumber(sample?.visibility?.firstVisibleAtMs),
    publicDisposition: sample?.visibility?.disposition ?? null,
    pacing: sample?.pacing ?? null,
  };
});
if (samples.length !== 10 || samples.some((sample) => sample.eventId === null || sample.suid === null)) {
  throw new Error("expected ten complete public cohort event/SUID identities");
}

const rowsByEvent = new Map();
for (const row of ledgerRows) {
  const list = rowsByEvent.get(row.event_id) ?? [];
  list.push(row);
  rowsByEvent.set(row.event_id, list);
}

const mvBySuid = new Map();
for (const row of mvRows) {
  const key = row.source_suid ?? "";
  const list = mvBySuid.get(key) ?? [];
  list.push(row);
  mvBySuid.set(key, list);
}

const normalized = samples.map((sample) => {
  const eventRows = rowsByEvent.get(sample.eventId) ?? [];
  const reservationPartition = `reservation:${sample.reservationId}`;
  const identitySet = new Set(eventRows.map((row) => `${row.suid}|${row.attempt_id}`));
  const original = {};
  for (const stage of ORIGINAL_STAGES) {
    const row = stage === "command-receipt"
      ? rowFor(eventRows, (candidate) => candidate.ledger === "hop" && candidate.stage === stage && candidate.partition_tag === "")
      : stage === "first-unsafe-visible-read"
        ? rowFor(eventRows, (candidate) => candidate.ledger === "hop" && candidate.stage === stage && candidate.view_id === "ReservationProjector")
        : rowFor(eventRows, (candidate) => candidate.ledger === "hop" && candidate.stage === stage && candidate.partition_tag === reservationPartition);
    original[stage] = row === null ? null : {
      observedAtMs: asNumber(row.observed_at),
      partitionTag: row.partition_tag ?? "",
      viewId: row.view_id ?? "",
      transport: row.transport ?? "",
      attemptId: row.attempt_id ?? null,
      suid: row.suid ?? null,
    };
  }
  const subRows = eventRows.filter((candidate) => candidate.ledger === "sub" && candidate.partition_tag === reservationPartition);
  const sub = {};
  for (const stage of [
    "post-record-delivery-global-receipt-readback",
    "source-tag-acknowledgement",
    "completeness-coverage",
    "detector",
  ]) {
    const start = rowFor(subRows, (candidate) => candidate.stage === stage && candidate.boundary === "start");
    const end = rowFor(subRows, (candidate) => candidate.stage === stage && candidate.boundary === "end");
    sub[stage] = {
      start: start === null ? null : { observedAtMs: asNumber(start.observed_at), outcome: start.outcome ?? null, partitionTag: start.partition_tag ?? "", viewId: start.view_id ?? "" },
      end: end === null ? null : { observedAtMs: asNumber(end.observed_at), outcome: end.outcome ?? null, partitionTag: end.partition_tag ?? "", viewId: end.view_id ?? "" },
      durationMs: start !== null && end !== null ? asNumber(end.observed_at) - asNumber(start.observed_at) : null,
      outcome: end?.outcome ?? null,
    };
  }
  const unsafeViews = {};
  for (const viewId of ["RoomProjector", "ReservationProjector"]) {
    const start = rowFor(subRows, (candidate) => candidate.stage === "unsafe-view-apply" && candidate.boundary === "start" && candidate.view_id === viewId);
    const end = rowFor(subRows, (candidate) => candidate.stage === "unsafe-view-apply" && candidate.boundary === "end" && candidate.view_id === viewId);
    unsafeViews[viewId] = {
      start: start === null ? null : { observedAtMs: asNumber(start.observed_at), outcome: start.outcome ?? null, partitionTag: start.partition_tag ?? "", viewId },
      end: end === null ? null : { observedAtMs: asNumber(end.observed_at), outcome: end.outcome ?? null, partitionTag: end.partition_tag ?? "", viewId },
      durationMs: start !== null && end !== null ? asNumber(end.observed_at) - asNumber(start.observed_at) : null,
      outcome: end?.outcome ?? null,
    };
  }
  const recordAt = original["record-delivery-batch-committed"]?.observedAtMs;
  const firstUnsafeAt = original["first-unsafe-visible-read"]?.observedAtMs;
  const globalStart = sub["post-record-delivery-global-receipt-readback"].start?.observedAtMs ?? null;
  const globalEnd = sub["post-record-delivery-global-receipt-readback"].end?.observedAtMs ?? null;
  const mvProvenance = mvBySuid.get(sample.suid) ?? [];
  const reservationRows = mvProvenance.filter((row) => row.ledger === "mv_rows" && row.view_id === "ReservationProjector");
  const unsafeReceipts = mvProvenance.filter((row) => row.ledger === "unsafe_receipt");
  const unsafeRows = mvProvenance.filter((row) => row.ledger === "mv_unsafe_rows");
  const candidates = [
    ["command receipt -> tag append committed", original["command-receipt"]?.observedAtMs !== null && original["tag-append-committed"]?.observedAtMs !== null ? original["tag-append-committed"].observedAtMs - original["command-receipt"].observedAtMs : null],
    ["tag append committed -> outbox obligation written", original["tag-append-committed"]?.observedAtMs !== null && original["outbox-obligation-written"]?.observedAtMs !== null ? original["outbox-obligation-written"].observedAtMs - original["tag-append-committed"].observedAtMs : null],
    ["outbox obligation written -> queue send returned", original["outbox-obligation-written"]?.observedAtMs !== null && original["queue-send-returned"]?.observedAtMs !== null ? original["queue-send-returned"].observedAtMs - original["outbox-obligation-written"].observedAtMs : null],
    ["queue send returned -> consumer invocation started", original["queue-send-returned"]?.observedAtMs !== null && original["consumer-invocation-started"]?.observedAtMs !== null ? original["consumer-invocation-started"].observedAtMs - original["queue-send-returned"].observedAtMs : null],
    ["consumer invocation started -> record-delivery batch committed", original["consumer-invocation-started"]?.observedAtMs !== null && original["record-delivery-batch-committed"]?.observedAtMs !== null ? original["record-delivery-batch-committed"].observedAtMs - original["consumer-invocation-started"].observedAtMs : null],
    ["record-delivery batch committed -> global receipt readback start", recordAt !== null && globalStart !== null ? globalStart - recordAt : null],
    ["global receipt readback start -> end", globalStart !== null && globalEnd !== null ? globalEnd - globalStart : null],
    ["source Tag acknowledgement", sub["source-tag-acknowledgement"].durationMs],
    ["completeness coverage", sub["completeness-coverage"].durationMs],
    ["detector", sub.detector.durationMs],
    ["RoomProjector unsafe-view apply", unsafeViews.RoomProjector.durationMs],
    ["ReservationProjector unsafe-view apply", unsafeViews.ReservationProjector.durationMs],
    ["record-delivery batch committed -> durable first unsafe-visible read", recordAt !== null && firstUnsafeAt !== null ? firstUnsafeAt - recordAt : null],
    ["last completed delivery boundary -> public first visibility", recordAt !== null && sample.publicVisibleAtMs !== null ? sample.publicVisibleAtMs - recordAt : null],
  ];
  const completeCandidates = candidates.filter(([, value]) => Number.isFinite(value) && value >= 0);
  const dominant = completeCandidates.sort((left, right) => right[1] - left[1])[0] ?? null;
  return {
    ...sample,
    reservationPartition,
    ledgerObservedRows: eventRows.length,
    identity: {
      observedIdentities: [...identitySet],
      unresolved: eventRows.length === 0,
      ambiguous: identitySet.size > 1 || eventRows.some((row) => row.suid !== sample.suid),
    },
    original,
    sub,
    unsafeViews,
    residuals: {
      recordToGlobalReadbackStartMs: recordAt !== null && globalStart !== null ? globalStart - recordAt : null,
      recordToDurableFirstUnsafeMs: recordAt !== null && firstUnsafeAt !== null ? firstUnsafeAt - recordAt : null,
      lastCompletedDeliveryToPublicMs: recordAt !== null && sample.publicVisibleAtMs !== null ? sample.publicVisibleAtMs - recordAt : null,
    },
    mvProvenance: {
      reservationRows,
      unsafeReceipts,
      unsafeRows,
      reservationRowCount: reservationRows.length,
      unsafeReceiptCount: unsafeReceipts.length,
      unsafeRowCount: unsafeRows.length,
    },
    dominantCompletedInterval: dominant === null ? null : { name: dominant[0], valueMs: Math.round(dominant[1]) },
  };
});

function adjacentSummary(from, to) {
  const values = normalized.map((sample) => {
    const left = sample.original[from]?.observedAtMs;
    const right = sample.original[to]?.observedAtMs;
    return left !== null && right !== null ? right - left : null;
  });
  return { from, to, ...stats(values, normalized.length) };
}

function subSummary(name, values, outcomes = null) {
  const summary = { name, ...stats(values, normalized.length) };
  if (outcomes !== null) {
    summary.outcomes = Object.fromEntries([...new Set(outcomes.filter((outcome) => outcome !== null))].sort().map((outcome) => [outcome, outcomes.filter((candidate) => candidate === outcome).length]));
  }
  return summary;
}

const adjacent = [];
for (let index = 0; index < ORIGINAL_STAGES.length - 1; index += 1) adjacent.push(adjacentSummary(ORIGINAL_STAGES[index], ORIGINAL_STAGES[index + 1]));
const subSummaries = [
  subSummary("record-delivery batch committed -> global receipt readback start", normalized.map((sample) => sample.residuals.recordToGlobalReadbackStartMs)),
  subSummary("global receipt readback start -> end", normalized.map((sample) => sample.sub["post-record-delivery-global-receipt-readback"].durationMs), normalized.map((sample) => sample.sub["post-record-delivery-global-receipt-readback"].outcome)),
  subSummary("source Tag acknowledgement start -> end", normalized.map((sample) => sample.sub["source-tag-acknowledgement"].durationMs), normalized.map((sample) => sample.sub["source-tag-acknowledgement"].outcome)),
  subSummary("completeness coverage start -> end", normalized.map((sample) => sample.sub["completeness-coverage"].durationMs), normalized.map((sample) => sample.sub["completeness-coverage"].outcome)),
  subSummary("detector start -> end", normalized.map((sample) => sample.sub.detector.durationMs), normalized.map((sample) => sample.sub.detector.outcome)),
  subSummary("RoomProjector unsafe-view apply start -> end", normalized.map((sample) => sample.unsafeViews.RoomProjector.durationMs), normalized.map((sample) => sample.unsafeViews.RoomProjector.outcome)),
  subSummary("ReservationProjector unsafe-view apply start -> end", normalized.map((sample) => sample.unsafeViews.ReservationProjector.durationMs), normalized.map((sample) => sample.unsafeViews.ReservationProjector.outcome)),
  subSummary("record-delivery batch committed -> durable first unsafe-visible read", normalized.map((sample) => sample.residuals.recordToDurableFirstUnsafeMs)),
  subSummary("last completed delivery boundary -> public first visibility", normalized.map((sample) => sample.residuals.lastCompletedDeliveryToPublicMs)),
];
const publicValues = normalized.map((sample) => sample.publicVisibilityMs);
const publicSummary = {
  n: normalized.length,
  observedN: publicValues.filter((value) => value !== null).length,
  censoredN: publicValues.filter((value) => value === null).length,
  p50MsObservedOnly: nearestRank(publicValues.filter((value) => value !== null), 0.5),
  p95MsObservedOnly: nearestRank(publicValues.filter((value) => value !== null), 0.95),
  countOver5000MsStrict: publicValues.filter((value) => value !== null && value > 5000).length,
  countMissingOrCensored: publicValues.filter((value) => value === null).length,
  valuesMs: normalized.map((sample) => ({ ordinal: sample.ordinal, reservationId: sample.reservationId, valueMs: sample.publicVisibilityMs, disposition: sample.publicDisposition })),
};
const report = {
  schema: "sdt-g60-w152-hop-analysis/v1",
  task: "SDT-G60-AUTHORITY-B-RETRY-W152",
  status: "completed-measurement-ac3-failed",
  sourceCommit: "4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2",
  serviceId: "sekiban-dcb-meeting-room-cloudflare-only",
  config: "samples/meeting-room/wrangler.cloudflare-only.jsonc",
  tokenEnvironment: Object.fromEntries(STRIPPED_NAMES.map((name) => [name, "UNSET"])),
  cohortPath,
  ledgerPath,
  mvPath,
  rawLedgerRowCount: ledgerRows.length,
  rawMvRowCount: mvRows.length,
  publicSummary,
  originalStages: ORIGINAL_STAGES,
  originalAdjacentSummaries: adjacent,
  postAdmissionSummaries: subSummaries,
  correlation: {
    unresolvedN: normalized.filter((sample) => sample.identity.unresolved).length,
    ambiguousN: normalized.filter((sample) => sample.identity.ambiguous).length,
    allAttempts: [...new Set(ledgerRows.map((row) => row.attempt_id))],
    perSample: normalized.map((sample) => ({ ordinal: sample.ordinal, eventId: sample.eventId, suid: sample.suid, attemptId: sample.original["command-receipt"]?.attemptId ?? null, ledgerRows: sample.ledgerObservedRows, observedIdentities: sample.identity.observedIdentities, unresolved: sample.identity.unresolved, ambiguous: sample.identity.ambiguous })),
  },
  mvSummary: {
    reservationRows: normalized.reduce((sum, sample) => sum + sample.mvProvenance.reservationRowCount, 0),
    unsafeReceipts: normalized.reduce((sum, sample) => sum + sample.mvProvenance.unsafeReceiptCount, 0),
    unsafeRows: normalized.reduce((sum, sample) => sum + sample.mvProvenance.unsafeRowCount, 0),
    exactReservationSuidMatches: normalized.filter((sample) => sample.mvProvenance.reservationRows.some((row) => row.source_suid === sample.suid)).length,
  },
  perSample: normalized,
  interpretation: {
    strict5000Contract: publicSummary.countOver5000MsStrict === 0 && publicSummary.censoredN === 0 ? "passed" : "failed",
    observerPerturbation: "unproven: one instrumented cohort and no matched observer-free control",
    dominantRule: "largest non-negative completed adjacent/sub-hop or residual interval in the persisted correlated rows; missing/censored spans are not fabricated",
    frozenBoundaries: "5,000 ms constant, durability, ordering, fences, G53 naming, G55 reads, G58 behavior, and the outbox/Queue/global-admission path outside banked W144 were unchanged",
  },
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, n: publicSummary.n, observedN: publicSummary.observedN, over5000: publicSummary.countOver5000MsStrict, dominant: normalized.map((sample) => ({ ordinal: sample.ordinal, dominant: sample.dominantCompletedInterval })) }) + "\n");

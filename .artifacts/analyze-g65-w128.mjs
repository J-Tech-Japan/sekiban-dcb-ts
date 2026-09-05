import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const root = process.cwd();
const outputPath = resolve(args.get("--output"));
const postPath = resolve(args.get("--post"));
const pipelineFiles = JSON.parse(args.get("--pipeline"));
const mvFiles = JSON.parse(args.get("--mv"));
const restoredPath = resolve(args.get("--restored"));
const unavailablePath = resolve(args.get("--unavailable"));

function jsonFile(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function rowsFromWrangler(path) {
  const receipt = jsonFile(path);
  const start = receipt.stdout.indexOf("[");
  if (start < 0) return [];
  try { return JSON.parse(receipt.stdout.slice(start))[0]?.results ?? []; } catch { return []; }
}
function nearest(values, percentile) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return finite.length === 0 ? null : finite[Math.max(0, Math.ceil(percentile * finite.length) - 1)];
}
function metrics(values, overMs = 5000) {
  const finite = values.filter((value) => Number.isFinite(value));
  return {
    n: values.length,
    observedN: finite.length,
    censoredN: values.length - finite.length,
    p50Ms: nearest(finite, 0.5),
    p95Ms: nearest(finite, 0.95),
    minMs: finite.length ? Math.min(...finite) : null,
    maxMs: finite.length ? Math.max(...finite) : null,
    over5000MsStrict: finite.filter((value) => value > overMs).length,
  };
}
function group(rows, key) {
  const map = new Map();
  for (const row of rows) { const value = row[key]; const list = map.get(value) ?? []; list.push(row); map.set(value, list); }
  return map;
}
function minAt(rows) { return rows.length ? Math.min(...rows.map((row) => Number(row.observed_at)).filter(Number.isFinite)) : null; }
function maxAt(rows) { return rows.length ? Math.max(...rows.map((row) => Number(row.observed_at)).filter(Number.isFinite)) : null; }
function stageRows(rows, stage) { return rows.filter((row) => row.stage === stage); }
function boundaryRows(rows, stage, boundary, viewId = undefined) {
  return rows.filter((row) => row.stage === stage && row.boundary === boundary && (viewId === undefined || row.view_id === viewId));
}
function durationFor(rows, stage, viewId = undefined) {
  const starts = boundaryRows(rows, stage, "start", viewId);
  const ends = boundaryRows(rows, stage, "end", viewId);
  const start = minAt(starts);
  const end = ends.filter((candidate) => start === null || Number(candidate.observed_at) >= start).sort((a, b) => Number(a.observed_at) - Number(b.observed_at))[0];
  return { startAt: start, endAt: end ? Number(end.observed_at) : null, durationMs: start !== null && end ? Number(end.observed_at) - start : null, outcomes: [...new Set(ends.map((row) => row.outcome))] };
}
function outcomeCounts(rows) { const result = {}; for (const row of rows) result[row.outcome] = (result[row.outcome] ?? 0) + 1; return result; }
function readCohort(path) { return jsonFile(path); }

const cohort = readCohort(postPath);
const events = cohort.reservations.map((sample) => {
  const event = sample.commit.rawResponse.body.response.writtenEvents[0];
  return { sample, eventId: event.id, suid: event.sortableUniqueIdValue, tags: event.tags };
});
const hopRows = rowsFromWrangler(pipelineFiles.hop);
const subRows = rowsFromWrangler(pipelineFiles.sub);
const writerRows = rowsFromWrangler(pipelineFiles.writer);
const globalReceiptRows = rowsFromWrangler(pipelineFiles.receipts);
const dcbEvents = rowsFromWrangler(pipelineFiles.events);
const mvUnsafeReceipts = rowsFromWrangler(mvFiles.unsafeReceipts);
const mvUnsafeRows = rowsFromWrangler(mvFiles.unsafeRows);
const hopsByEvent = group(hopRows, "event_id");
const subsByEvent = group(subRows, "event_id");
const writersByEvent = group(writerRows, "event_id");
const receiptsByEvent = group(globalReceiptRows, "event_id");
const mvReceiptsByEvent = group(mvUnsafeReceipts, "event_id");

const samples = events.map(({ sample, eventId, suid }) => {
  const hops = hopsByEvent.get(eventId) ?? [];
  const subs = subsByEvent.get(eventId) ?? [];
  const writers = writersByEvent.get(eventId) ?? [];
  const receipts = receiptsByEvent.get(eventId) ?? [];
  const eventRow = dcbEvents.find((row) => row.Id === eventId);
  const commandAt = minAt(stageRows(hops, "command-receipt"));
  const tagAt = minAt(stageRows(hops, "tag-append-committed"));
  const outboxAt = maxAt(stageRows(hops, "outbox-obligation-written"));
  const queueAt = maxAt(stageRows(hops, "queue-send-returned"));
  const consumerAt = maxAt(stageRows(hops, "consumer-invocation-started"));
  const deliveryAt = maxAt(stageRows(hops, "record-delivery-batch-committed"));
  const unsafeAt = minAt(stageRows(hops, "first-unsafe-visible-read"));
  const globalAt = receipts.length ? maxAt(receipts.map((row) => ({ observed_at: row.received_at }))) : null;
  const responseAt = sample.commit.receivedAtMs;
  const dcbEventAt = eventRow?.Timestamp === undefined ? null : Date.parse(eventRow.Timestamp);
  const synchronousAdmission = {
    outcome: globalAt !== null && globalAt <= responseAt ? "admitted-before-response" : "not-proven-before-response",
    firstGlobalReceiptAt: globalAt,
    receiptToResponseMs: globalAt === null ? null : responseAt - globalAt,
    fromOutboxToLastReceiptMs: globalAt === null || outboxAt === null ? null : globalAt - outboxAt,
    globalReceiptCount: receipts.length,
  };
  const adjacent = {
    commandToTagAppendMs: commandAt === null || tagAt === null ? null : tagAt - commandAt,
    tagAppendToOutboxMs: tagAt === null || outboxAt === null ? null : outboxAt - tagAt,
    outboxToQueueSendMs: outboxAt === null || queueAt === null ? null : queueAt - outboxAt,
    queueSendToConsumerStartMs: queueAt === null || consumerAt === null ? null : consumerAt - queueAt,
    consumerStartToRecordDeliveryMs: consumerAt === null || deliveryAt === null ? null : deliveryAt - consumerAt,
    recordDeliveryToFirstUnsafeMs: deliveryAt === null || unsafeAt === null ? null : unsafeAt - deliveryAt,
  };
  const postAdmission = {
    globalReceiptReadback: durationFor(subs, "post-record-delivery-global-receipt-readback"),
    sourceTagAcknowledgement: durationFor(subs, "source-tag-acknowledgement"),
    completenessCoverage: durationFor(subs, "completeness-coverage"),
    detector: durationFor(subs, "detector"),
    unsafeViewApply: Object.fromEntries(["RoomProjector", "ReservationProjector"].map((viewId) => [viewId, durationFor(subs, "unsafe-view-apply", viewId)])),
  };
  const writerByView = Object.fromEntries(["RoomProjector", "ReservationProjector"].map((viewId) => {
    const rows = writers.filter((row) => row.view_id === viewId);
    const starts = rows.filter((row) => row.boundary === "start");
    const ends = rows.filter((row) => row.boundary === "end");
    const start = minAt(starts);
    const end = ends.filter((row) => start === null || Number(row.observed_at) >= start).sort((a, b) => Number(a.observed_at) - Number(b.observed_at))[0];
    return [viewId, { startAt: start, endAt: end ? Number(end.observed_at) : null, durationMs: start !== null && end ? Number(end.observed_at) - start : null, outcomes: outcomeCounts(ends) }];
  }));
  return {
    ordinal: sample.ordinal,
    reservationId: sample.reservationId,
    eventId,
    suid,
    attemptId: hops[0]?.attempt_id ?? null,
    commitResponseMs: sample.commit.responseMs,
    commitReceivedAtMs: responseAt,
    globalDcbEventVisibility: {
      eventAt: Number.isFinite(dcbEventAt) ? dcbEventAt : null,
      commandReceiptToEventMs: commandAt === null || !Number.isFinite(dcbEventAt) ? null : dcbEventAt - commandAt,
      responseToEventMs: !Number.isFinite(dcbEventAt) ? null : dcbEventAt - responseAt,
      beforeResponse: Number.isFinite(dcbEventAt) && dcbEventAt <= responseAt,
    },
    publicUnsafeMs: sample.unsafe.firstVisibleCommitToUnsafeMs,
    publicUnsafeDisposition: sample.unsafe.disposition,
    safeMs: sample.finalProjectorHeadReachedAtMs === null ? null : sample.finalProjectorHeadReachedAtMs - responseAt,
    synchronousAdmission,
    adjacent,
    postAdmission,
    unsafeWriter: writerByView,
    mvUnsafeReceiptOutcomes: outcomeCounts(mvReceiptsByEvent.get(eventId) ?? []),
    recordedStages: [...new Set(hops.map((row) => row.stage))],
    missingStages: ["command-receipt", "tag-append-committed", "outbox-obligation-written", "queue-send-returned", "consumer-invocation-started", "record-delivery-batch-committed", "first-unsafe-visible-read"].filter((stage) => !hops.some((row) => row.stage === stage)),
  };
});

const adjacentMetrics = Object.fromEntries(Object.keys(samples[0]?.adjacent ?? {}).map((key) => [key, metrics(samples.map((sample) => sample.adjacent[key]))]));
const subhopMetrics = {
  postRecordDeliveryGlobalReceiptReadback: metrics(samples.map((sample) => sample.postAdmission.globalReceiptReadback.durationMs)),
  sourceTagAcknowledgement: metrics(samples.map((sample) => sample.postAdmission.sourceTagAcknowledgement.durationMs)),
  completenessCoverage: metrics(samples.map((sample) => sample.postAdmission.completenessCoverage.durationMs)),
  detector: metrics(samples.map((sample) => sample.postAdmission.detector.durationMs)),
  unsafeRoomProjector: metrics(samples.map((sample) => sample.postAdmission.unsafeViewApply.RoomProjector.durationMs)),
  unsafeReservationProjector: metrics(samples.map((sample) => sample.postAdmission.unsafeViewApply.ReservationProjector.durationMs)),
  unsafeWriterRoomProjector: metrics(samples.map((sample) => sample.unsafeWriter.RoomProjector.durationMs)),
  unsafeWriterReservationProjector: metrics(samples.map((sample) => sample.unsafeWriter.ReservationProjector.durationMs)),
};
const admissionDurations = samples.map((sample) => sample.synchronousAdmission.fromOutboxToLastReceiptMs);
const admissionOutcomes = outcomeCounts(samples.map((sample) => ({ outcome: sample.synchronousAdmission.outcome })));
const stageCounts = outcomeCounts(hopRows.map((row) => ({ outcome: row.stage })));
const subhopOutcomes = outcomeCounts(subRows.map((row) => ({ outcome: `${row.stage}:${row.outcome}` })));
const writerOutcomes = outcomeCounts(writerRows.map((row) => ({ outcome: `${row.writer_path}:${row.view_id}:${row.outcome}` })));
const unavailable = jsonFile(unavailablePath);
const restored = jsonFile(restoredPath);
const analysis = {
  schema: "sdt-g65-w128-analysis/v1",
  task: "SDT-G65-DEPLOYED-WAKE-128",
  post: {
    runId: cohort.runId,
    sourceHead: cohort.sourceHead,
    deployedVersionId: cohort.deployment.exactWorkerVersion,
    deploymentId: cohort.deployment.exactDeployment,
    proof: cohort.proof,
    metrics: {
      commitResponse: metrics(samples.map((sample) => sample.commitResponseMs)),
      globalDcbEventVisibility: metrics(samples.map((sample) => sample.globalDcbEventVisibility.commandReceiptToEventMs), 1000),
      publicUnsafeRecordedOnly: metrics(samples.map((sample) => sample.publicUnsafeMs)),
      safe: metrics(samples.map((sample) => sample.safeMs), 180000),
      synchronousAdmissionDuration: metrics(admissionDurations, 300),
      adjacent: adjacentMetrics,
      subhops: subhopMetrics,
    },
    synchronousAdmission: { outcomes: admissionOutcomes, maxReceiptToResponseMs: Math.max(...samples.map((sample) => sample.synchronousAdmission.receiptToResponseMs ?? -1)) },
    outcomeCounts: { originalStages: stageCounts, postAdmission: subhopOutcomes, unsafeWriters: writerOutcomes },
    d1Rows: { events: dcbEvents.length, globalReceipts: globalReceiptRows.length, hopMeasurements: hopRows.length, hopSubmeasurements: subRows.length, unsafeWriterBoundaries: writerRows.length, mvUnsafeReceipts: mvUnsafeReceipts.length, mvUnsafeRows: mvUnsafeRows.length },
    allRequiredStagesPresent: samples.every((sample) => sample.missingStages.length === 0),
    samples,
  },
  d1Unavailable: {
    runId: unavailable.runId,
    sourceHead: unavailable.sourceCommit,
    deployedVersionId: unavailable.deployedVersionId,
    n: unavailable.reservations.length,
    allCommitted: unavailable.reservations.every((sample) => sample.commit.status === 200 && sample.commit.body?.kind === "committed"),
    ryowMissesAtBound: unavailable.reservations.filter((sample) => sample.visibility?.firstVisibleAtMs === null).length,
    rows: unavailable.reservations.map((sample) => ({ ordinal: sample.ordinal, reservationId: sample.reservationId, suid: sample.suid, responseMs: sample.commit.elapsedMs, disposition: sample.visibility?.disposition, globalAdmissionHeader: sample.commit.globalAdmission ?? null })),
    restored,
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(analysis, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ output: outputPath, postSamples: samples.length, admissionOutcomes, publicUnsafe: analysis.post.metrics.publicUnsafeRecordedOnly, commitResponse: analysis.post.metrics.commitResponse }) + "\n");

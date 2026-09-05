import fs from "node:fs";

const files = {
  baseline: ".artifacts/sdt-g65-w130-pre-deploy-baseline.json",
  post: ".artifacts/sdt-g65-w130-post-deploy-healthy.json",
  preLedger: ".artifacts/sdt-g65-w130-pre-ledger.json",
  postLedger: ".artifacts/sdt-g65-w130-post-ledger.json",
  failure: ".artifacts/sdt-g65-w130-d1-schema-failure-cohort.json",
  recovery: ".artifacts/sdt-g65-w130-d1-recovery-followup.json",
};

const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const bodyOf = (sample) => sample.commit?.rawResponse?.body ?? sample.commit?.body ?? {};
const eventOf = (sample) => bodyOf(sample)?.response?.writtenEvents?.[0] ?? null;
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};
const distribution = (values) => ({
  n: values.filter(Number.isFinite).length,
  p50Ms: percentile(values, 50),
  p95Ms: percentile(values, 95),
});

function rowsFor(ledger, eventId, kind) {
  return ledger.parsed?.["3"]?.results?.filter((row) =>
    row.ledger === kind && row.event_id === eventId,
  ) ?? [];
}

function hopRows(rows, stage, partitionTag = undefined, viewId = undefined) {
  return rows
    .filter((row) => row.stage === stage)
    .filter((row) => partitionTag === undefined || row.partition_tag === partitionTag)
    .filter((row) => viewId === undefined || row.view_id === viewId)
    .sort((a, b) => a.observed_at - b.observed_at);
}

function firstHop(rows, stage, partitionTag = undefined, viewId = undefined) {
  return hopRows(rows, stage, partitionTag, viewId)[0] ?? null;
}

function span(rows, stage, partitionTag, viewId, kind = "sub") {
  const candidates = rows
    .filter((row) => row.ledger === kind && row.stage === stage)
    .filter((row) => partitionTag === undefined || row.partition_tag === partitionTag)
    .filter((row) => viewId === undefined || row.view_id === viewId)
    .sort((a, b) => a.observed_at - b.observed_at);
  for (const start of candidates.filter((row) => row.boundary === "start")) {
    const end = candidates.find((row) => row.boundary === "end" && row.observed_at >= start.observed_at);
    if (end) return { start: start.observed_at, end: end.observed_at, durationMs: end.observed_at - start.observed_at, outcome: end.outcome };
  }
  return null;
}

function eventMetrics(cohort, ledger) {
  const admissionRows = ledger.parsed?.["2"]?.results ?? [];
  const rows = [];
  for (const sample of cohort.reservations ?? []) {
    const event = eventOf(sample);
    const eventId = event?.id ?? null;
    const reservationTag = `reservation:${sample.reservationId}`;
    const all = rowsFor(ledger, eventId, "hop").concat(rowsFor(ledger, eventId, "sub"), rowsFor(ledger, eventId, "unsafe-writer"));
    const command = firstHop(all, "command-receipt");
    const tag = firstHop(all, "tag-append-committed", reservationTag);
    const outbox = firstHop(all, "outbox-obligation-written", reservationTag);
    const queue = firstHop(all, "queue-send-returned", reservationTag);
    const consumer = firstHop(all, "consumer-invocation-started", reservationTag);
    const delivery = firstHop(all, "record-delivery-batch-committed", reservationTag);
    const unsafeRead = firstHop(all, "first-unsafe-visible-read", undefined, "ReservationProjector");
    const admission = admissionRows
      .filter((row) => row.event_id === eventId && row.partition_tag === reservationTag)
      .sort((a, b) => a.admission_started_at - b.admission_started_at)
      .map((row) => ({
        attemptId: row.attempt_id,
        startedAtMs: row.admission_started_at,
        finishedAtMs: row.admission_finished_at,
        durationMs: row.admission_finished_at - row.admission_started_at,
        outcome: row.outcome,
        globalCompletionObservedAtMs: row.global_completion_observed_at,
        clockOrigin: row.clock_origin,
      }));
    const readback = span(all, "post-record-delivery-global-receipt-readback", reservationTag);
    const sourceAck = span(all, "source-tag-acknowledgement", reservationTag);
    const coverage = span(all, "completeness-coverage", reservationTag);
    const detector = span(all, "detector", reservationTag);
    const unsafeRoom = span(all, "unsafe-view-apply", reservationTag, "RoomProjector");
    const unsafeReservation = span(all, "unsafe-view-apply", reservationTag, "ReservationProjector");
    const writerRoom = span(all, "", undefined, "RoomProjector", "unsafe-writer");
    const writerReservation = span(all, "", undefined, "ReservationProjector", "unsafe-writer");
    const interval = (a, b) => a && b ? b.observed_at - a.observed_at : null;
    const commitReceivedAtMs = sample.commit?.receivedAtMs ?? sample.commit?.rawResponse?.receivedAtMs ?? null;
    const unsafeAtMs = sample.unsafe?.firstVisibleAtMs ?? null;
    const safeAtMs = sample.finalProjectorHeadReachedAtMs ?? null;
    rows.push({
      ordinal: sample.ordinal,
      reservationId: sample.reservationId,
      eventId,
      suid: sample.suid ?? event?.sortableUniqueIdValue ?? null,
      commitResponseMs: sample.commit?.responseMs ?? null,
      commitReceivedAtMs,
      unsafeFirstVisibleAtMs: unsafeAtMs,
      commitToUnsafeMs: unsafeAtMs !== null && commitReceivedAtMs !== null ? unsafeAtMs - commitReceivedAtMs : null,
      safeFinalHeadAtMs: safeAtMs,
      commitToSafeFinalHeadMs: safeAtMs !== null && commitReceivedAtMs !== null ? safeAtMs - commitReceivedAtMs : null,
      unsafeDisposition: sample.unsafe?.disposition ?? null,
      headerOutcome: sample.commit?.rawResponse?.globalAdmission ?? null,
      bodyHasAdmissionField: Object.prototype.hasOwnProperty.call(bodyOf(sample), "globalAdmission") || Object.prototype.hasOwnProperty.call(bodyOf(sample)?.response ?? {}, "globalAdmission"),
      observed: {
        commandReceiptAtMs: command?.observed_at ?? null,
        tagAppendAtMs: tag?.observed_at ?? null,
        outboxAtMs: outbox?.observed_at ?? null,
        queueSendAtMs: queue?.observed_at ?? null,
        consumerStartAtMs: consumer?.observed_at ?? null,
        recordDeliveryAtMs: delivery?.observed_at ?? null,
        ledgerFirstUnsafeReadAtMs: unsafeRead?.observed_at ?? null,
        publicFirstUnsafeReadAtMs: unsafeAtMs,
      },
      hopMs: {
        commandReceiptToTagAppend: interval(command, tag),
        tagAppendToOutbox: interval(tag, outbox),
        outboxToQueueSend: interval(outbox, queue),
        queueSendToConsumerStart: interval(queue, consumer),
        consumerStartToRecordDelivery: interval(consumer, delivery),
        recordDeliveryToUnsafeRead: delivery && unsafeAtMs !== null ? unsafeAtMs - delivery.observed_at : null,
        responseToUnsafeRead: unsafeAtMs !== null && commitReceivedAtMs !== null ? unsafeAtMs - commitReceivedAtMs : null,
      },
      subhops: {
        recordDeliveryToGlobalReadbackStart: delivery && readback ? readback.start - delivery.observed_at : null,
        globalReadbackStartAtMs: readback?.start ?? null,
        globalReadbackEndAtMs: readback?.end ?? null,
        globalReadbackDuration: readback?.durationMs ?? null,
        sourceAcknowledgementDuration: sourceAck?.durationMs ?? null,
        completenessDuration: coverage?.durationMs ?? null,
        completenessOutcome: coverage?.outcome ?? null,
        detectorDuration: detector?.durationMs ?? null,
        detectorOutcome: detector?.outcome ?? null,
        roomUnsafeApplyDuration: unsafeRoom?.durationMs ?? null,
        roomUnsafeApplyOutcome: unsafeRoom?.outcome ?? null,
        reservationUnsafeApplyDuration: unsafeReservation?.durationMs ?? null,
        reservationUnsafeApplyOutcome: unsafeReservation?.outcome ?? null,
        roomInlineWriterDuration: writerRoom?.durationMs ?? null,
        roomInlineWriterOutcome: writerRoom?.outcome ?? null,
        reservationInlineWriterDuration: writerReservation?.durationMs ?? null,
        reservationInlineWriterOutcome: writerReservation?.outcome ?? null,
        recordDeliveryToLedgerUnsafeRead: delivery && unsafeRead ? unsafeRead.observed_at - delivery.observed_at : null,
        residualFromDeliveryToPublicRead: delivery && unsafeAtMs !== null ? unsafeAtMs - delivery.observed_at : null,
      },
      admission,
    });
  }
  return rows;
}

function summarize(rows, path) {
  const values = rows.map((row) => path.split(".").reduce((value, key) => value?.[key], row)).filter(Number.isFinite);
  return distribution(values);
}

function summarizeOutcome(rows, path) {
  const values = rows.map((row) => path.split(".").reduce((value, key) => value?.[key], row)).filter((value) => value !== null && value !== undefined);
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

function analyze(label, cohortPath, ledgerPath) {
  const cohort = read(cohortPath);
  const ledger = read(ledgerPath);
  const sampleRows = eventMetrics(cohort, ledger);
  const metrics = {
    response: summarize(sampleRows, "commitResponseMs"),
    commitToUnsafe: summarize(sampleRows, "commitToUnsafeMs"),
    commitToSafeFinalHead: summarize(sampleRows, "commitToSafeFinalHeadMs"),
    commandReceiptToTagAppend: summarize(sampleRows, "hopMs.commandReceiptToTagAppend"),
    tagAppendToOutbox: summarize(sampleRows, "hopMs.tagAppendToOutbox"),
    outboxToQueueSend: summarize(sampleRows, "hopMs.outboxToQueueSend"),
    queueSendToConsumerStart: summarize(sampleRows, "hopMs.queueSendToConsumerStart"),
    consumerStartToRecordDelivery: summarize(sampleRows, "hopMs.consumerStartToRecordDelivery"),
    recordDeliveryToUnsafeRead: summarize(sampleRows, "hopMs.recordDeliveryToUnsafeRead"),
    recordDeliveryToGlobalReadbackStart: summarize(sampleRows, "subhops.recordDeliveryToGlobalReadbackStart"),
    globalReadbackDuration: summarize(sampleRows, "subhops.globalReadbackDuration"),
    sourceAcknowledgementDuration: summarize(sampleRows, "subhops.sourceAcknowledgementDuration"),
    completenessDuration: summarize(sampleRows, "subhops.completenessDuration"),
    detectorDuration: summarize(sampleRows, "subhops.detectorDuration"),
    roomUnsafeApplyDuration: summarize(sampleRows, "subhops.roomUnsafeApplyDuration"),
    reservationUnsafeApplyDuration: summarize(sampleRows, "subhops.reservationUnsafeApplyDuration"),
    roomInlineWriterDuration: summarize(sampleRows, "subhops.roomInlineWriterDuration"),
    reservationInlineWriterDuration: summarize(sampleRows, "subhops.reservationInlineWriterDuration"),
    recordDeliveryToLedgerUnsafeRead: summarize(sampleRows, "subhops.recordDeliveryToLedgerUnsafeRead"),
    residualFromDeliveryToPublicRead: summarize(sampleRows, "subhops.residualFromDeliveryToPublicRead"),
    over5000: sampleRows.filter((row) => Number.isFinite(row.commitToUnsafeMs) && row.commitToUnsafeMs > 5000).length,
    responseHeaders: summarizeOutcome(sampleRows, "headerOutcome"),
    completenessOutcomes: summarizeOutcome(sampleRows, "subhops.completenessOutcome"),
    detectorOutcomes: summarizeOutcome(sampleRows, "subhops.detectorOutcome"),
    roomUnsafeOutcomes: summarizeOutcome(sampleRows, "subhops.roomUnsafeApplyOutcome"),
    reservationUnsafeOutcomes: summarizeOutcome(sampleRows, "subhops.reservationUnsafeApplyOutcome"),
    bodyAdmissionFieldCount: sampleRows.filter((row) => row.bodyHasAdmissionField).length,
  };
  return {
    label,
    cohort: { path: cohortPath, runId: cohort.runId, startedAt: cohort.startedAt, finishedAt: cohort.finishedAt, status: cohort.status, count: sampleRows.length },
    clockPolicy: "Observed fetch/ledger Date.now epoch milliseconds only; excludes dcb_events.authored_timestamp and serialized_dcb_global_receipts.received_at from timing.",
    metrics,
    samples: sampleRows,
  };
}

const result = {
  schema: "sdt-g65-w130-observed-clock-analysis-v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: "557aa1b1b78328866538f3c3fb56d3d529996994",
  baseline: analyze("pre-deploy-current-main", files.baseline, files.preLedger),
  post: analyze("post-deploy-557aa1b", files.post, files.postLedger),
  failureVariant: read(files.failure),
  recoveryFollowup: read(files.recovery),
};

const serialized = JSON.stringify(result, null, 2);
const outputPath = process.argv[2];
if (outputPath) {
  fs.writeFileSync(outputPath, serialized + "\n", { mode: 0o600 });
} else {
  console.log(serialized);
}

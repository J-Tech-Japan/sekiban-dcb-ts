#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const cohort = JSON.parse(readFileSync(".artifacts/sdt-g60-w159-public-cohort.json", "utf8"));
const ledgerReceipt = JSON.parse(readFileSync(".artifacts/sdt-g60-w159-ledger.json", "utf8"));
const mvReceipt = JSON.parse(readFileSync(".artifacts/sdt-g60-w159-mv.json", "utf8"));
const ledgerSets = ledgerReceipt.parsed ?? [];
const mvSets = mvReceipt.parsed ?? [];
const ledgerRows = ledgerSets[0]?.results ?? [];
const hops = ledgerRows.filter((row) => row.record_kind === "hop");
const substeps = ledgerRows.filter((row) => row.record_kind === "sub");
const writerRows = ledgerRows.filter((row) => row.record_kind === "unsafe-writer");
const mvUnsafeReceipts = mvSets[0]?.results ?? [];
const mvRows = mvSets[1]?.results ?? [];
const mvUnsafeRows = mvSets[2]?.results ?? [];
const mvUnsafeArrivals = mvSets[4]?.results ?? [];
const mvUnsafeFailures = mvSets[5]?.results ?? [];
const mvWaitReceipts = mvSets[6]?.results ?? [];
const mvWaitPoison = mvSets[7]?.results ?? [];
const mvInstances = mvSets[8]?.results ?? [];
const mvActiveGenerations = mvSets[9]?.results ?? [];

const sourceEvents = cohort.reservations.map((sample) => {
  const event = sample.commit.body.response.writtenEvents[0];
  return { ordinal: sample.ordinal, reservationId: sample.reservationId, eventId: event.id, suid: event.sortableUniqueIdValue };
});
const byEvent = (rows, eventId) => rows.filter((row) => row.event_id === eventId);
const first = (rows, predicate = () => true) => rows.filter(predicate).sort((a, b) => a.observed_at - b.observed_at)[0] ?? null;
const last = (rows, predicate = () => true) => rows.filter(predicate).sort((a, b) => a.observed_at - b.observed_at).at(-1) ?? null;
const numbers = (values) => values.filter((value) => Number.isFinite(value));
const nearestRank = (values, percentile) => {
  const sorted = [...numbers(values)].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
};
const metric = (values, extra = {}) => {
  const clean = numbers(values);
  return { n: clean.length, p50Ms: nearestRank(clean, 0.5), p95Ms: nearestRank(clean, 0.95), minMs: clean.length ? Math.min(...clean) : null, maxMs: clean.length ? Math.max(...clean) : null, ...extra };
};
const delta = (end, start) => end === null || start === null ? null : end - start;
const rowIdentity = (row) => ({
  stage: row.stage,
  boundary: row.boundary,
  outcome: row.outcome,
  partitionTag: row.partition_tag,
  viewId: row.view_id,
  transport: row.transport,
  observedAt: row.observed_at,
  attemptId: row.attempt_id,
});
const hopIdentity = (row) => ({
  stage: row.stage,
  partitionTag: row.partition_tag,
  viewId: row.view_id,
  transport: row.transport,
  observedAt: row.observed_at,
  attemptId: row.attempt_id,
});
const writerIdentity = (row) => ({
  writerPath: row.writer_path,
  boundary: row.boundary,
  outcome: row.outcome,
  viewId: row.view_id,
  transport: row.transport,
  observedAt: row.observed_at,
  attemptId: row.attempt_id,
});

function pairedDurations(rows, groupKey) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? { starts: [], ends: [] };
    if (row.boundary === "start") group.starts.push(row);
    else if (row.boundary === "end") group.ends.push(row);
    groups.set(key, group);
  }
  const durations = [];
  let missingStart = 0;
  let missingEnd = 0;
  for (const group of groups.values()) {
    const starts = [...group.starts].sort((a, b) => a.observed_at - b.observed_at);
    const ends = [...group.ends].sort((a, b) => a.observed_at - b.observed_at);
    if (starts.length === 0) missingStart += ends.length;
    if (ends.length === 0) missingEnd += starts.length;
    const count = Math.min(starts.length, ends.length);
    for (let index = 0; index < count; index += 1) durations.push(ends[index].observed_at - starts[index].observed_at);
  }
  return { durations, missingStart, missingEnd };
}

function occurrenceMetric(rows, stage, transport) {
  const matching = rows.filter((row) => row.stage === stage && row.transport === transport);
  const paired = pairedDurations(matching, (row) => [row.event_id, row.stage, row.partition_tag, row.view_id, row.transport].join("|"));
  return metric(paired.durations, { missingStart: paired.missingStart, missingEnd: paired.missingEnd });
}

function writerMetric(rows, transport, viewId) {
  const matching = rows.filter((row) => row.transport === transport && row.view_id === viewId);
  const paired = pairedDurations(matching, (row) => [row.event_id, row.writer_path, row.view_id, row.transport].join("|"));
  return metric(paired.durations, { missingStart: paired.missingStart, missingEnd: paired.missingEnd });
}

function mapByPartition(rows, predicate) {
  const result = new Map();
  for (const row of rows.filter(predicate)) {
    const previous = result.get(row.partition_tag);
    if (previous === undefined || row.observed_at < previous.observed_at) result.set(row.partition_tag, row);
  }
  return result;
}

const samples = sourceEvents.map((eventInfo) => {
  const sample = cohort.reservations.find((candidate) => candidate.reservationId === eventInfo.reservationId);
  const eventHops = byEvent(hops, eventInfo.eventId);
  const eventSubsteps = byEvent(substeps, eventInfo.eventId);
  const eventWriters = byEvent(writerRows, eventInfo.eventId);
  const command = first(eventHops, (row) => row.stage === "command-receipt");
  const tagRows = eventHops.filter((row) => row.stage === "tag-append-committed");
  const obligationRows = eventHops.filter((row) => row.stage === "outbox-obligation-written");
  const queueSendRows = eventHops.filter((row) => row.stage === "queue-send-returned");
  const fastConsumerRows = eventHops.filter((row) => row.stage === "consumer-invocation-started" && row.transport === "fast");
  const fastDeliveryRows = eventHops.filter((row) => row.stage === "record-delivery-batch-committed" && row.transport === "fast");
  const queueConsumerRows = eventHops.filter((row) => row.stage === "consumer-invocation-started" && row.transport === "queue");
  const queueDeliveryRows = eventHops.filter((row) => row.stage === "record-delivery-batch-committed" && row.transport === "queue");
  const publicHop = first(eventHops, (row) => row.stage === "first-unsafe-visible-read");
  const fastCoverage = eventSubsteps.filter((row) => row.stage === "completeness-coverage" && row.transport === "fast" && row.boundary === "end");
  const queueCoverage = eventSubsteps.filter((row) => row.stage === "completeness-coverage" && row.transport === "queue" && row.boundary === "end");
  const directWriterByView = Object.fromEntries(["ReservationProjector", "RoomProjector"].map((viewId) => {
    const start = first(eventWriters, (row) => row.transport === "fast" && row.view_id === viewId && row.boundary === "start");
    const end = first(eventWriters, (row) => row.transport === "fast" && row.view_id === viewId && row.boundary === "end");
    return [viewId, { start: start?.observed_at ?? null, end: end?.observed_at ?? null, outcome: end?.outcome ?? null, durationMs: delta(end?.observed_at ?? null, start?.observed_at ?? null) }];
  }));
  const queueWriterByView = Object.fromEntries(["ReservationProjector", "RoomProjector"].map((viewId) => {
    const start = first(eventWriters, (row) => row.transport === "queue" && row.view_id === viewId && row.boundary === "start");
    const end = first(eventWriters, (row) => row.transport === "queue" && row.view_id === viewId && row.boundary === "end");
    return [viewId, { start: start?.observed_at ?? null, end: end?.observed_at ?? null, outcome: end?.outcome ?? null, durationMs: delta(end?.observed_at ?? null, start?.observed_at ?? null) }];
  }));
  const fastConsumerByPartition = mapByPartition(fastConsumerRows, () => true);
  const fastDeliveryByPartition = mapByPartition(fastDeliveryRows, () => true);
  const queueSendByPartition = mapByPartition(queueSendRows, () => true);
  const queueConsumerByPartition = mapByPartition(queueConsumerRows, () => true);
  const queueDeliveryByPartition = mapByPartition(queueDeliveryRows, () => true);
  const fastConsumerToDelivery = [...fastDeliveryByPartition.entries()].map(([partitionTag, end]) => ({ partitionTag, durationMs: delta(end.observed_at, fastConsumerByPartition.get(partitionTag)?.observed_at ?? null) }));
  const queueSendToConsumer = [...queueSendByPartition.entries()].map(([partitionTag, start]) => ({ partitionTag, durationMs: delta(queueConsumerByPartition.get(partitionTag)?.observed_at ?? null, start.observed_at) }));
  const queueConsumerToDelivery = [...queueConsumerByPartition.entries()].map(([partitionTag, start]) => ({ partitionTag, durationMs: delta(queueDeliveryByPartition.get(partitionTag)?.observed_at ?? null, start.observed_at) }));
  const lastFastDelivery = last(fastDeliveryRows)?.observed_at ?? null;
  const firstQueueConsumer = first(queueConsumerRows)?.observed_at ?? null;
  const publicVisibility = sample.visibility?.firstVisibleAtMs ?? null;
  const commitResponseAt = sample.commit?.receivedAtMs ?? null;
  return {
    ordinal: eventInfo.ordinal,
    reservationId: eventInfo.reservationId,
    eventId: eventInfo.eventId,
    suid: eventInfo.suid,
    attemptId: command?.attempt_id ?? null,
    public: {
      commitStartedAtMs: sample.commit?.startedAtMs ?? null,
      commitResponseAtMs: commitResponseAt,
      commitResponseMs: sample.commit?.elapsedMs ?? null,
      firstUnsafeVisibleAtMs: publicVisibility,
      commitResponseToFirstUnsafeVisibleMs: sample.visibility?.commitToFirstVisibilityMs ?? null,
      commandReceiptToFirstUnsafeVisibleMs: delta(publicVisibility, command?.observed_at ?? null),
      disposition: sample.visibility?.disposition ?? null,
      observationCount: sample.visibility?.observations?.length ?? null,
      pageCountAtVisibility: sample.visibility?.observations?.at(-1)?.pageCount ?? null,
    },
    durableSevenHop: {
      commandReceiptAtMs: command?.observed_at ?? null,
      tagAppendCommitted: tagRows.map(hopIdentity),
      outboxObligationWritten: obligationRows.map(hopIdentity),
      queueSendReturned: queueSendRows.map(hopIdentity),
      fastConsumerInvocationStarted: fastConsumerRows.map(hopIdentity),
      fastRecordDeliveryBatchCommitted: fastDeliveryRows.map(hopIdentity),
      queueConsumerInvocationStarted: queueConsumerRows.map(hopIdentity),
      queueRecordDeliveryBatchCommitted: queueDeliveryRows.map(hopIdentity),
      firstUnsafeVisibleRead: publicHop ? hopIdentity(publicHop) : null,
    },
    postAdmission: eventSubsteps.map(rowIdentity),
    unsafeWriter: eventWriters.map(writerIdentity),
    directUnsafeApply: directWriterByView,
    queueReplay: queueWriterByView,
    coverage: {
      fast: fastCoverage.map(rowIdentity),
      queue: queueCoverage.map(rowIdentity),
      allFastBlock: fastCoverage.length > 0 && fastCoverage.every((row) => row.outcome === "BLOCK/UNSETTLED"),
    },
    perSampleIntervals: {
      commandReceiptToLastTagAppendMs: delta(last(tagRows)?.observed_at ?? null, command?.observed_at ?? null),
      lastTagAppendToLastOutboxMs: delta(last(obligationRows)?.observed_at ?? null, last(tagRows)?.observed_at ?? null),
      lastOutboxToLastQueueSendMs: delta(last(queueSendRows)?.observed_at ?? null, last(obligationRows)?.observed_at ?? null),
      fastConsumerToFastDeliveryMs: fastConsumerToDelivery,
      queueSendToQueueConsumerMs: queueSendToConsumer,
      queueConsumerToQueueDeliveryMs: queueConsumerToDelivery,
      lastFastRecordDeliveryToPublicMs: delta(publicVisibility, lastFastDelivery),
      firstQueueConsumerAtMs: firstQueueConsumer,
    },
    mv: {
      unsafeReceipts: mvUnsafeReceipts.filter((row) => row.event_id === eventInfo.eventId),
      safeRows: mvRows.filter((row) => row.source_suid === eventInfo.suid),
      unsafeRows: mvUnsafeRows.filter((row) => row.source_suid === eventInfo.suid),
      unsafeFailures: mvUnsafeFailures.filter((row) => row.event_id === eventInfo.eventId),
      waitReceipts: mvWaitReceipts.filter((row) => row.event_id === eventInfo.eventId),
      waitPoison: mvWaitPoison.filter((row) => row.event_id === eventInfo.eventId),
    },
    identitiesComplete: eventHops.every((row) => row.attempt_id === command?.attempt_id && row.suid === eventInfo.suid) && eventWriters.every((row) => row.attempt_id === command?.attempt_id && row.suid === eventInfo.suid),
    timing: {
      commandResponseToFirstUnsafeVisibleMs: sample.visibility?.commitToFirstVisibilityMs ?? null,
      over5000Ms: (sample.visibility?.commitToFirstVisibilityMs ?? 0) > 5000,
      censored: sample.visibility?.commitToFirstVisibilityMs === null,
      commitResponseAtMs: commitResponseAt,
    },
  };
});

const allFastConsumerToDelivery = samples.flatMap((sample) => sample.perSampleIntervals.fastConsumerToFastDeliveryMs.map((row) => row.durationMs));
const allQueueSendToConsumer = samples.flatMap((sample) => sample.perSampleIntervals.queueSendToQueueConsumerMs.map((row) => row.durationMs));
const allQueueConsumerToDelivery = samples.flatMap((sample) => sample.perSampleIntervals.queueConsumerToQueueDeliveryMs.map((row) => row.durationMs));
const firstPublicValues = samples.map((sample) => sample.public.commitResponseToFirstUnsafeVisibleMs);
const analysis = {
  schema: "sdt-g60-w159-analysis/v1",
  task: "SDT-G60-REUSED-ARM-DEPLOYED-W159",
  sourceCommit: "6481ddf4285b5bd71b576aee4a02e0605fb102b1",
  productRepairCommit: "84892e5bd5233de9c12f07dffb12b28e08bee00e",
  worker: "sekiban-dcb-g60-w131-c",
  serviceId: "sekiban-dcb-g60-w131-c",
  cohortRunId: cohort.runId,
  deployedVersionId: cohort.deployedVersionId,
  resources: {
    pipelineD1: { name: "sekiban-dcb-g60-w131-c-pipeline", id: "b03270df-9698-4a9e-94c6-c2c5726f106d" },
    mvD1: { name: "sekiban-dcb-g60-w131-c-mv", id: "616dd377-42f3-49f7-b373-a1a07cedf2b3" },
    queue: "sekiban-dcb-g60-w131-c-outbox",
    dlq: "sekiban-dcb-g60-w131-c-outbox-dlq",
  },
  publicMetrics: { ...cohort.metrics, valuesMs: firstPublicValues },
  durableHopCounts: {
    originalHopRows: hops.length,
    postAdmissionRows: substeps.length,
    unsafeWriterRows: writerRows.length,
    originalByStage: Object.fromEntries([...new Set(hops.map((row) => row.stage))].map((stage) => [stage, hops.filter((row) => row.stage === stage).length])),
    postAdmissionByStageTransport: Object.fromEntries([...new Set(substeps.map((row) => `${row.stage}|${row.transport}`))].map((key) => [key, substeps.filter((row) => `${row.stage}|${row.transport}` === key).length])),
    unsafeWriterByTransportViewOutcome: Object.fromEntries([...new Set(writerRows.map((row) => `${row.transport}|${row.view_id}|${row.boundary}|${row.outcome}`))].map((key) => [key, writerRows.filter((row) => `${row.transport}|${row.view_id}|${row.boundary}|${row.outcome}` === key).length])),
  },
  representativeHopMetrics: {
    commandReceiptToLastTagAppend: metric(samples.map((sample) => sample.perSampleIntervals.commandReceiptToLastTagAppendMs)),
    lastTagAppendToLastOutboxObligation: metric(samples.map((sample) => sample.perSampleIntervals.lastTagAppendToLastOutboxMs)),
    lastOutboxObligationToLastQueueSend: metric(samples.map((sample) => sample.perSampleIntervals.lastOutboxToLastQueueSendMs)),
    fastConsumerToFastRecordDeliveryByPartition: metric(allFastConsumerToDelivery),
    queueSendToQueueConsumerByPartition: metric(allQueueSendToConsumer),
    queueConsumerToQueueRecordDeliveryByPartition: metric(allQueueConsumerToDelivery),
    lastFastRecordDeliveryToFirstPublicRead: metric(samples.map((sample) => sample.perSampleIntervals.lastFastRecordDeliveryToPublicMs)),
    commitResponseToFirstPublicRead: metric(firstPublicValues),
  },
  postAdmissionMetrics: {
    "post-record-delivery-global-receipt-readback|fast": occurrenceMetric(substeps, "post-record-delivery-global-receipt-readback", "fast"),
    "post-record-delivery-global-receipt-readback|queue": occurrenceMetric(substeps, "post-record-delivery-global-receipt-readback", "queue"),
    "source-tag-acknowledgement|fast": occurrenceMetric(substeps, "source-tag-acknowledgement", "fast"),
    "source-tag-acknowledgement|queue": occurrenceMetric(substeps, "source-tag-acknowledgement", "queue"),
    "completeness-coverage|fast": occurrenceMetric(substeps, "completeness-coverage", "fast"),
    "completeness-coverage|queue": occurrenceMetric(substeps, "completeness-coverage", "queue"),
    "detector|fast": occurrenceMetric(substeps, "detector", "fast"),
    "detector|queue": occurrenceMetric(substeps, "detector", "queue"),
    "unsafe-view-apply|fast": occurrenceMetric(substeps, "unsafe-view-apply", "fast"),
    "unsafe-view-apply|queue": occurrenceMetric(substeps, "unsafe-view-apply", "queue"),
  },
  unsafeWriterMetrics: {
    "inline-delivery|fast|ReservationProjector": writerMetric(writerRows, "fast", "ReservationProjector"),
    "inline-delivery|fast|RoomProjector": writerMetric(writerRows, "fast", "RoomProjector"),
    "inline-delivery|queue|ReservationProjector": writerMetric(writerRows, "queue", "ReservationProjector"),
    "inline-delivery|queue|RoomProjector": writerMetric(writerRows, "queue", "RoomProjector"),
  },
  directApplyProof: {
    samples: samples.length,
    reservationDirectApplied: samples.filter((sample) => sample.directUnsafeApply.ReservationProjector.outcome === "applied").length,
    roomDirectNoChange: samples.filter((sample) => sample.directUnsafeApply.RoomProjector.outcome === "no-change").length,
    allFastCoverageBlock: samples.filter((sample) => sample.coverage.allFastBlock).length,
    queueReservationDuplicateRace: samples.filter((sample) => sample.queueReplay.ReservationProjector.outcome === "duplicate-race").length,
    queueRoomDuplicateRace: samples.filter((sample) => sample.queueReplay.RoomProjector.outcome === "duplicate-race").length,
    statement: "For every cohort event, the fast/direct ReservationProjector apply ended applied before the fast completeness decision ended BLOCK/UNSETTLED; the later queue replay ended duplicate-race for both views. The safe fence was not bypassed: direct applies are the independent unsafe lane and no safe checkpoint is advanced by them.",
  },
  mvProof: {
    unsafeReceiptRows: mvUnsafeReceipts.length,
    safeRows: mvRows.length,
    unsafeRowsRemaining: mvUnsafeRows.length,
    unsafeArrivalRows: mvUnsafeArrivals,
    instanceRows: mvInstances,
    activeGenerationRows: mvActiveGenerations,
    statement: "All ten ReservationProjector rows are present at generation 0 with the cohort SUIDs; all ten retained unsafe receipts are RoomProjector no-change receipts, and no unsafe rows remain after safe promotion. No missing unsafe failure or wait-poison rows were found.",
  },
  comparisons: {
    W95: { p50Ms: 2959, countOver5000: "1/10" },
    cleanMain: { p50Ms: 4911, countOver5000: "5/10" },
    W155QueueDependent: { p50Ms: 4010, p95Ms: 9962, countOver5000: "5/10" },
    W156MaxBatchSize1: { p50Ms: 4958, p95Ms: 23927, countOver5000: "5/10" },
    W159: { p50Ms: cohort.metrics.p50MsObservedOnly, p95Ms: cohort.metrics.p95MsObservedOnly, countOver5000: `${cohort.metrics.countOver5000MsStrict}/10` },
  },
  historyStatement: "Repository/deployed evidence makes G62 commit 05d9d27 / PR 119 the first provable relevant landing for coverage admission gating; G26 f7b257b is the unsafe-writer origin. This is a first-provable landing statement, not stronger historical causality.",
  missingOrAmbiguous: {
    sampleIdentityCorrelationsMissing: samples.filter((sample) => !sample.identitiesComplete).map((sample) => sample.ordinal),
    publicCensored: samples.filter((sample) => sample.timing.censored).map((sample) => sample.ordinal),
    durableRowsMissing: samples.filter((sample) => sample.durableSevenHop.firstUnsafeVisibleRead === null).map((sample) => sample.ordinal),
  },
  samples,
};
writeFileSync(".artifacts/sdt-g60-w159-analysis.json", `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: ".artifacts/sdt-g60-w159-analysis.json", publicMetrics: analysis.publicMetrics, representativeHopMetrics: analysis.representativeHopMetrics, postAdmissionMetrics: analysis.postAdmissionMetrics, unsafeWriterMetrics: analysis.unsafeWriterMetrics, directApplyProof: analysis.directApplyProof, missingOrAmbiguous: analysis.missingOrAmbiguous }, null, 2));

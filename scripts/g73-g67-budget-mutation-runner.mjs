#!/usr/bin/env node
/**
 * G73 AC3 budget proof.
 *
 * Vitest's JSON reporter supplies the selected test body's duration. The
 * healthy and regression observations therefore use the same clock interval;
 * process startup/teardown is retained only as separately reported overhead.
 * The temporary regression mutant repeats the real G69 admission-diagnostic
 * path, calibrated from a measured round, rather than inserting a timer or a
 * synthetic delay. The selected ten-second test-body budget must stay green
 * for the healthy path and fail specifically with Vitest's timeout for the
 * measured G69-added-work representative.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const testFile = "test/g67-safe-lane.spec.ts";
const testName = "AC3: ten paced commits converge through kicks with cron disabled and record delivery-to-safe intervals";
const mutationAnchor = "        await Promise.all(waiters);\n\n        const publicResponse = await publicFetch";
const budgetMs = 10_000;
const calibrationRounds = 32;
const g69OperationsPerRound = 2;
const safetyFactor = 1.5;
const maxRepresentativeRounds = 4096;
const originalRunnerSha256 =
  "74e024444725c5aa01f01b8e1346b5329099e9c60135babd66186a11e1c3d7ee";
const directTimingMarker = "G80_G73_DIRECT_TIMING";
const sgrSequencePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);
const observationRoot = resolve(root, ".artifacts", "sdt-g80-observation");
const timerResolutionFloorMs = 1;
const allowanceMadFactor = 3;
// G90: equal-size residual bound from hosted green-run census at main baseline
// b6c1a6e — p99 paired-residual max 6 ms across 12 greens → ceil(6 + 1) = 7.
const equalSizeResidualBoundMs = 7;
const durableRecordPrefix = "G80_CALIBRATION_RECORD";
const durableSummaryPrefix = "G80_CALIBRATION_SUMMARY";
const maxDurableRecordBytes = 12_000;
const durableRecordSchema = "sdt-g80-calibration-record-v3";
const directTimingPlan = Object.freeze({
  warmUpRounds: 16,
  chunks: [8, 8, 8, 8, 8],
  scoringRounds: 40,
  maxElapsedMs: 5_000,
  clockProbeCount: 3,
  // Workerd/Miniflare can resolve a handful of fast D1 reads to the same
  // performance.now tick.  Keep the probe real and bounded, but use enough
  // repeated reads to validate the clock's observable resolution rather than
  // treating a timer-quantized zero as a calibration result.
  clockProbeQueries: 32,
  operationsPerRound: g69OperationsPerRound,
});
let reportCounter = 0;
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const pinnedVitestVersion = "4.1.10";

function installedVitestVersion() {
  try {
    return JSON.parse(
      readFileSync(resolve(root, "node_modules/vitest/package.json"), "utf8"),
    ).version ?? null;
  } catch {
    return null;
  }
}

function safeLabel(label) {
  return String(label).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function gitIdentity() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function receiptMetadata() {
  const immutableHead = process.env.GITHUB_SHA ?? gitIdentity();
  return {
    sourceSha: immutableHead,
    immutableHead,
    checkout: root,
    workflow: process.env.GITHUB_WORKFLOW ?? "local",
    job: process.env.GITHUB_JOB ?? "local",
    runId: process.env.GITHUB_RUN_ID ?? "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
    runnerOs: process.env.RUNNER_OS ?? process.platform,
    node: process.version,
  };
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("median requires at least one value");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function medianAbsoluteDeviation(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function assertionResults(report) {
  if (!report || !Array.isArray(report.testResults)) return [];
  return report.testResults.flatMap((file) =>
    Array.isArray(file.assertionResults) ? file.assertionResults : [],
  );
}

function matchingTargetResults(report) {
  return assertionResults(report).filter(
    (result) =>
      typeof result?.fullName === "string" &&
      result.fullName.endsWith(testName),
  );
}

function matchingReceiptTests(receipt) {
  if (!receipt || !Array.isArray(receipt.tests)) return [];
  return receipt.tests.filter((test) =>
    typeof test?.module === "string" &&
    test.module.endsWith(testFile) &&
    typeof test?.fullName === "string" &&
    test.fullName.endsWith(testName),
  );
}

function boundedText(value, maxBytes = 512) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end) + "...[truncated]", "utf8") > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end) + "...[truncated]";
}

function compactError(error) {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return boundedText(error);
  return {
    name: boundedText(error.name ?? null, 128),
    message: boundedText(error.message ?? error, 512),
    stack: boundedText(error.stack ?? null, 512),
    code: boundedText(error.code ?? null, 128),
  };
}

function compactTarget(target) {
  if (target === null || target === undefined) return null;
  return {
    module: boundedText(target.module ?? target.fileName ?? null, 256),
    fullName: boundedText(target.fullName ?? null, 512),
    state: target.state ?? null,
    status: target.status ?? null,
    durationMs: Number.isFinite(target.durationMs) ? target.durationMs : null,
    configuredTimeoutMs: Number.isFinite(target.configuredTimeoutMs)
      ? target.configuredTimeoutMs
      : null,
    retryCount: target.retryCount ?? null,
    repeatCount: target.repeatCount ?? null,
    errors: Array.isArray(target.errors)
      ? target.errors.slice(0, 8).map(compactError)
      : [],
  };
}

function oracleEvidence(result) {
  if (result === null || result === undefined) return null;
  return {
    label: boundedText(result.label, 256),
    process: {
      status: result.processStatus,
      signal: result.signal,
      spawnError: boundedText(result.spawnError, 512),
      elapsedMs: result.processElapsedMs,
    },
    body: {
      status: result.bodyStatus ?? null,
      durationMs: Number.isFinite(result.bodyDurationMs) ? result.bodyDurationMs : null,
    },
    target: {
      reportCount: result.targetCount,
      receiptCount: result.receiptTargetCount,
      report: compactTarget(result.reportTarget),
      receipt: compactTarget(result.receiptTarget),
      failedTestCount: Array.isArray(result.receiptTests)
        ? result.receiptTests.filter((test) => test?.state === "failed").length
        : null,
    },
    versions: {
      report: boundedText(result.vitestVersion, 64),
      receipt: boundedText(result.receiptVitestVersion, 64),
      installed: boundedText(result.installedVitestVersion, 64),
    },
    receiptFinalStatus: result.receiptFinalStatus,
    failureMessages: Array.isArray(result.failureMessages)
      ? result.failureMessages.slice(0, 8).map((message) => boundedText(message, 512))
      : [],
    collectionErrors: Array.isArray(result.collectionErrors)
      ? result.collectionErrors.slice(0, 8).map(compactError)
      : [],
    unhandledErrors: Array.isArray(result.unhandledErrors)
      ? result.unhandledErrors.slice(0, 8).map(compactError)
      : [],
    reportError: boundedText(result.reportError, 512),
    receiptError: boundedText(result.receiptError, 512),
    directTiming: result.directTiming,
    directTimingError: boundedText(result.directTimingError, 512),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function stripRecordDigests(record) {
  const core = { ...record };
  delete core.canonicalDigest;
  delete core.reconstructionDigest;
  return core;
}

function durableRecordLine(prefix, record) {
  const line = prefix + " " + JSON.stringify(record);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > maxDurableRecordBytes) {
    throw new Error(`G80 durable ${prefix} record exceeds ${maxDurableRecordBytes} bytes: ${bytes}`);
  }
  return line;
}

function createDurableRecord(core) {
  return {
    ...core,
    canonicalDigest: canonicalDigest(core),
  };
}

function emitDurableRecord(prefix, core) {
  const record = createDurableRecord(core);
  process.stdout.write(durableRecordLine(prefix, record) + "\n");
  return record;
}

function recordReference(record) {
  return {
    stageId: record.stageId,
    canonicalDigest: record.canonicalDigest,
  };
}

function createDurableSummary(stageRecords, fields) {
  const stageRefs = stageRecords.map(recordReference);
  const core = {
    schema: durableRecordSchema,
    recordType: "summary",
    observationId: fields.observationId ?? "g80-calibration-run",
    metadata: receiptMetadata(),
    ...fields,
    stageRefs,
  };
  return createDurableRecord({
    ...core,
    reconstructionDigest: canonicalDigest({ summary: core, stages: stageRefs }),
  });
}

function reconstructDurableRecords(lines) {
  const stages = [];
  const summaries = [];
  const sourceLines = Array.isArray(lines) ? lines : String(lines).split("\n");
  for (const line of sourceLines.filter((value) => value.length > 0)) {
    const prefix = line.startsWith(durableRecordPrefix + " ")
      ? durableRecordPrefix
      : line.startsWith(durableSummaryPrefix + " ")
        ? durableSummaryPrefix
        : null;
    if (prefix === null) throw new Error("G80 durable reconstruction found an unrelated line");
    if (Buffer.byteLength(line, "utf8") > maxDurableRecordBytes) {
      throw new Error("G80 durable reconstruction found a line over the bounded limit");
    }
    let record;
    try {
      record = JSON.parse(line.slice(prefix.length + 1));
    } catch (error) {
      throw new Error("G80 durable reconstruction found malformed JSON: " + String(error));
    }
    if (record?.schema !== durableRecordSchema || typeof record.canonicalDigest !== "string") {
      throw new Error("G80 durable reconstruction found an incomplete record");
    }
    const canonicalCore = { ...record };
    delete canonicalCore.canonicalDigest;
    if (canonicalDigest(canonicalCore) !== record.canonicalDigest) {
      throw new Error("G80 durable reconstruction canonical digest mismatch");
    }
    if (prefix === durableRecordPrefix) stages.push(record);
    else summaries.push(record);
  }
  if (summaries.length !== 1) throw new Error("G80 durable reconstruction requires exactly one summary");
  const summary = summaries[0];
  if (!Array.isArray(summary.stageRefs) || summary.stageRefs.length !== stages.length) {
    throw new Error("G80 durable reconstruction stage references are incomplete");
  }
  const stagesById = new Map(stages.map((stage) => [stage.stageId, stage]));
  for (const reference of summary.stageRefs) {
    const stage = stagesById.get(reference.stageId);
    if (!stage || stage.canonicalDigest !== reference.canonicalDigest) {
      throw new Error("G80 durable reconstruction stage reference mismatch");
    }
  }
  if (typeof summary.reconstructionDigest !== "string") {
    throw new Error("G80 durable reconstruction digest is missing");
  }
  const summaryCore = stripRecordDigests(summary);
  if (canonicalDigest({ summary: summaryCore, stages: summary.stageRefs }) !== summary.reconstructionDigest) {
    throw new Error("G80 durable reconstruction digest mismatch");
  }
  return { stages, summary };
}

function pinnedVitestVersionMatches(result) {
  return result?.receiptVitestVersion === pinnedVitestVersion &&
    result?.installedVitestVersion === pinnedVitestVersion;
}

function calibrationFailureDetails(healthy, calibration, extra = {}) {
  const healthyBodyMs = healthy?.bodyDurationMs;
  const calibrationBodyMs = calibration?.bodyDurationMs;
  const signedDifferenceMs = Number.isFinite(healthyBodyMs) && Number.isFinite(calibrationBodyMs)
    ? calibrationBodyMs - healthyBodyMs
    : null;
  return {
    ...extra,
    healthyBodyMs: Number.isFinite(healthyBodyMs) ? healthyBodyMs : null,
    calibrationBodyMs: Number.isFinite(calibrationBodyMs) ? calibrationBodyMs : null,
    signedDifferenceMs,
    healthyObservation: oracleEvidence(healthy),
    calibrationObservation: oracleEvidence(calibration),
    directTiming: calibration?.directTiming ?? null,
    directTimingError: calibration?.directTimingError ?? null,
    uncertainty: {
      observedRateSpread: extra.observedRateSpread ?? null,
      costsPerRoundMs: extra.costsPerRoundMs ?? null,
      pairedResidualsMs: extra.pairedResidualsMs ?? null,
      residualRangeMs: extra.residualRangeMs ?? null,
      equalSizeResidualBoundMs: extra.equalSizeResidualBoundMs ?? equalSizeResidualBoundMs,
      allowanceMs: extra.allowanceMs ?? null,
    },
    representativeSelection: "not-reached",
    attempts: [],
    semanticTimeout: "not-reached",
  };
}

function compactFailureDetails(details) {
  if (!details || typeof details !== "object") return {};
  const retainedKeys = [
    "reason",
    "comparison",
    "healthyBodyMs",
    "calibrationBodyMs",
    "signedDifferenceMs",
    "directTiming",
    "directTimingError",
    "uncertainty",
    "allowance",
    "allowanceMs",
    "directRateLowerBoundMs",
    "directRateMedianMs",
    "predictedAddedWorkMs",
    "wholeTestAttributionRatio",
    "timing",
    "observedRateSpread",
    "costsPerRoundMs",
    "pairedResidualsMs",
    "residualRangeMs",
    "equalSizeResidualBoundMs",
    "healthyObservation",
    "calibrationObservation",
  ];
  return Object.fromEntries(
    retainedKeys
      .filter((key) => details[key] !== undefined)
      .map((key) => [key, details[key]]),
  );
}

function emitStage(stages, stage, result, fields = {}) {
  const {
    observationId: suppliedObservationId,
    stageId: suppliedStageId,
    ...stageFields
  } = fields;
  const observationId = safeLabel(
    suppliedObservationId ?? result?.label ?? `g80-${stage}`,
  );
  const stageId = suppliedStageId ?? `${observationId}:${safeLabel(stage)}:${stages.length + 1}`;
  const record = emitDurableRecord(durableRecordPrefix, {
    schema: durableRecordSchema,
    recordType: "stage",
    observationId,
    stageId,
    stage,
    metadata: receiptMetadata(),
    ...stageFields,
    observation: oracleEvidence(result),
  });
  stages.push(record);
  return record;
}

function ensureObservationRoot() {
  mkdirSync(observationRoot, { recursive: true });
  return observationRoot;
}

function legacyG69AddedWorkBlock(rounds) {
  return `        // Temporary W201 mutant: repeat the actual G69 admission-diagnostic
      // path once for the first real commit using unique, valid D1 envelopes.
      // No timer or synthetic delay is part of the regression representative.
      // Keeping the calibrated block to one real commit prevents the nominal
      // 32-round observation from multiplying across all ten paced commits.
      // Each round is a bounded batch of complete real deliveries so its
      // measured cost remains observable without exhausting hosted Workerd.
      if (index === 1) {
        const g73G69ExtraRounds = ${rounds};
        const g73G69OperationsPerRound = ${g69OperationsPerRound};
        const extraStore = new D1EventStore(database);
        await extraStore.initialize();
        const extraTemplate = queued[0];
        if (extraTemplate === undefined) throw new Error("G67 calibration requires a real queued template");
        for (let g73Round = 0; g73Round < g73G69ExtraRounds; g73Round += 1) {
          // A fresh round identity keeps the diagnostic trim bounded per
          // calibration service while retaining complete real admissions.
          const extraServiceId = \`\${serviceId}-g73-g69-calibration-\${g73Round}\`;
          const extraTag = \`room:g73-g69-calibration-\${g73Round}\`;
          for (let g73Operation = 0; g73Operation < g73G69OperationsPerRound; g73Operation += 1) {
            const extraWaiters: Promise<void>[] = [];
            const extraMessage = g32Message({
              serviceId: extraServiceId,
              allocatorLineageId: extraTemplate.allocatorLineageId,
              tag: extraTag,
              attemptId: \`g73-calibration-attempt-\${index}-\${g73Round}-\${g73Operation}\`,
              eventId: \`g73-calibration-event-\${index}-\${g73Round}-\${g73Operation}\`,
              suid: g32SuidAt(deliveredAt, (g73Round * g73G69OperationsPerRound) + g73Operation + 1),
              payload: extraTemplate.payload,
              eventTags: [extraTag],
              eventType: extraTemplate.eventType,
              enqueuedAt: deliveredAt - 100,
              obligationSequence: (g73Round * g73G69OperationsPerRound) + g73Operation + 1,
            });
            await extraStore.recordDelivery(extraMessage, deliveredAt, "queue", {
              waitUntil: (promise: Promise<void>) => { extraWaiters.push(promise); },
            });
            await Promise.all(extraWaiters);
          }
        }
      }
`;
}

function scoringRoundsTotal() {
  return directTimingPlan.chunks.reduce((sum, chunk) => sum + chunk, 0);
}

function directMutationRoundsTotal() {
  return directTimingPlan.warmUpRounds + scoringRoundsTotal();
}

function chunkPlanFor(rounds, { directTiming = false } = {}) {
  if (directTiming) {
    if (rounds !== directMutationRoundsTotal()) {
      throw new Error(
        "G90 direct timing requires " + directMutationRoundsTotal() +
        " total mutation rounds (" + directTimingPlan.warmUpRounds + " warm-up + " +
        scoringRoundsTotal() + " scoring)",
      );
    }
    return [...directTimingPlan.chunks];
  }
  const plan = [];
  let remaining = rounds;
  for (const candidate of directTimingPlan.chunks) {
    if (remaining === 0) break;
    const chunk = Math.min(candidate, remaining);
    plan.push(chunk);
    remaining -= chunk;
  }
  if (remaining > 0) plan.push(remaining);
  return plan;
}

function g69AddedWorkBlock(rounds, { directTiming = false } = {}) {
  const chunkPlan = directTiming ? chunkPlanFor(rounds, { directTiming: true }) : [rounds];
  const clockStart = directTiming ? "performance.now()" : "0";
  const clockDuration = directTiming
    ? "performance.now() - g73ChunkStartedAt"
    : "0";
  const initializationStart = directTiming ? "performance.now()" : "0";
  const directValidation = directTiming
    ? [
        "            if (!Number.isFinite(g73ChunkDurationMs) || g73ChunkDurationMs <= 0) {",
        '              throw new Error("G80 direct timing requires a finite positive clock advance");',
        "            }",
        "            if (performance.now() - g73MeasurementStartedAt > " +
          directTimingPlan.maxElapsedMs +
          ") {",
        '              throw new Error("G80 direct timing ceiling exceeded");',
        "            }",
      ]
    : [];
  const directTail = directTiming
    ? [
        "          const g73ScoringRounds = g73TimingChunks.reduce((sum, chunk) => sum + chunk.rounds, 0);",
        "          if (g73RoundOffset !== g73G69ExtraRounds || g73ScoringRounds !== " + scoringRoundsTotal() + ") {",
        '            throw new Error("G90 direct timing did not account for warm-up and scoring rounds");',
        "          }",
        "          const g73PositiveIntervals = g73TimingChunks.map((chunk) => chunk.durationMs);",
        "          const g73MinObservedAdvanceMs = Math.min(...g73PositiveIntervals);",
        "          console.log(" +
          JSON.stringify(directTimingMarker) +
          ' + " " + JSON.stringify({',
        '            clock: "performance.now",',
        '            clockValidation: {',
        '              probe: "D1 SELECT 1",',
        "              samples: g80ClockProbeAdvances.length,",
        "              queriesPerSample: " + directTimingPlan.clockProbeQueries + ",",
        "              minAdvanceMs: g80ClockProbeMinAdvanceMs,",
        "              maxAdvanceMs: g80ClockProbeMaxAdvanceMs,",
        "              monotonic: true,",
        '            },',
        "            initializationMs: g73InitializationDurationMs,",
        "            initializationSeparated: true,",
        "            warmUpRounds: g73WarmUpRounds,",
        "            warmUpDurationMs: g73WarmUpDurationMs,",
        "            warmUpExcludedFromGates: true,",
        "            chunks: g73TimingChunks,",
        "            scoringRounds: g73ScoringRounds,",
        "            totalRounds: g73ScoringRounds,",
        "            operationsPerRound: g73G69OperationsPerRound,",
        "            deliveryCount: g73ScoringRounds * g73G69OperationsPerRound,",
        "            waitersDrained: true,",
        "            skippedDeliveries: 0,",
        "            omittedWaiterDrain: false,",
        "            wrongCount: false,",
        "            timerOnly: false,",
        "            clockAdvancesDuringRealWork: true,",
        "            minObservedAdvanceMs: g73MinObservedAdvanceMs,",
        "          }));",
      ]
    : [];
  return [
    "        // G80 direct-timing mutant: measure complete real G69 deliveries with",
    "        // performance.now inside the temporary mutation. No timer or synthetic",
    "        // delay is part of the representative.",
    "        if (index === 1) {",
    "          const g73G69ExtraRounds = " + rounds + ";",
    "          const g73G69OperationsPerRound = " + g69OperationsPerRound + ";",
    "          const g73MeasurementStartedAt = " + initializationStart + ";",
    "          const g73TimingChunks = [];",
    "          const extraStore = new D1EventStore(database);",
    "          const g73InitializationStartedAt = " + initializationStart + ";",
    "          await extraStore.initialize();",
    "          const g73InitializationDurationMs = " +
      (directTiming
        ? "performance.now() - g73InitializationStartedAt"
        : "0") +
      ";",
    "          const extraTemplate = queued[0];",
    '          if (extraTemplate === undefined) throw new Error("G67 calibration requires a real queued template");',
    ...(directTiming
      ? [
          "          const g80ClockProbeAdvances = [];",
          "          for (let g80Probe = 0; g80Probe < " + directTimingPlan.clockProbeCount + "; g80Probe += 1) {",
          "            const g80ProbeStartedAt = performance.now();",
          "            for (let g80ProbeQuery = 0; g80ProbeQuery < " + directTimingPlan.clockProbeQueries + "; g80ProbeQuery += 1) {",
          '              await database.prepare("SELECT 1 AS g80_clock_probe").all();',
          "            }",
          "            const g80ProbeFinishedAt = performance.now();",
          "            if (!Number.isFinite(g80ProbeStartedAt) || !Number.isFinite(g80ProbeFinishedAt) || g80ProbeFinishedAt <= g80ProbeStartedAt) {",
          '              throw new Error("G80 direct timing clock probe did not advance positively");',
          "            }",
          "            g80ClockProbeAdvances.push(g80ProbeFinishedAt - g80ProbeStartedAt);",
          "          }",
        "          const g80ClockProbeMinAdvanceMs = Math.min(...g80ClockProbeAdvances);",
        "          const g80ClockProbeMaxAdvanceMs = Math.max(...g80ClockProbeAdvances);",
        ]
      : []),
    ...(directTiming
      ? [
          "          let g73RoundOffset = 0;",
          "          const g73WarmUpRounds = " + directTimingPlan.warmUpRounds + ";",
          "          const g73WarmUpStartedAt = performance.now();",
          "          for (let g73WarmUpRound = 0; g73WarmUpRound < g73WarmUpRounds; g73WarmUpRound += 1) {",
          "            const extraServiceId = String(serviceId) + \"-g73-g69-warmup-\" + String(g73RoundOffset);",
          "            const extraTag = \"room:g73-g69-warmup-\" + String(g73RoundOffset);",
          "            for (let g73Operation = 0; g73Operation < g73G69OperationsPerRound; g73Operation += 1) {",
          "              const extraWaiters: Promise<void>[] = [];",
          "              const extraMessage = g32Message({",
          "                serviceId: extraServiceId,",
          "                allocatorLineageId: extraTemplate.allocatorLineageId,",
          "                tag: extraTag,",
          "                attemptId: \"g73-warmup-attempt-\" + String(index) + \"-\" + String(g73RoundOffset) + \"-\" + String(g73Operation),",
          "                eventId: \"g73-warmup-event-\" + String(index) + \"-\" + String(g73RoundOffset) + \"-\" + String(g73Operation),",
          "                suid: g32SuidAt(deliveredAt, g73RoundOffset * g73G69OperationsPerRound + g73Operation + 1),",
          "                payload: extraTemplate.payload,",
          "                eventTags: [extraTag],",
          "                eventType: extraTemplate.eventType,",
          "                enqueuedAt: deliveredAt - 100,",
          "                obligationSequence: g73RoundOffset * g73G69OperationsPerRound + g73Operation + 1,",
          "              });",
          '              await extraStore.recordDelivery(extraMessage, deliveredAt, "queue", {',
          "                waitUntil: (promise: Promise<void>) => { extraWaiters.push(promise); },",
          "              });",
          "              await Promise.all(extraWaiters);",
          "            }",
          "            g73RoundOffset += 1;",
          "          }",
          "          const g73WarmUpDurationMs = performance.now() - g73WarmUpStartedAt;",
          "          if (!Number.isFinite(g73WarmUpDurationMs) || g73WarmUpDurationMs <= 0) {",
          '            throw new Error("G90 warm-up requires a finite positive duration");',
          "          }",
        ]
      : ["          let g73RoundOffset = 0;"]),
    "          const g73ChunkPlan = " + JSON.stringify(chunkPlan) + ";",
    "          for (const g73ChunkRounds of g73ChunkPlan) {",
    "            const g73ChunkStartedAt = " + clockStart + ";",
    "            for (let g73Round = 0; g73Round < g73ChunkRounds; g73Round += 1) {",
    "              const extraServiceId = String(serviceId) + \"-g73-g69-calibration-\" + String(g73RoundOffset + g73Round);",
    "              const extraTag = \"room:g73-g69-calibration-\" + String(g73RoundOffset + g73Round);",
    "              for (let g73Operation = 0; g73Operation < g73G69OperationsPerRound; g73Operation += 1) {",
    "                const extraWaiters: Promise<void>[] = [];",
    "                const extraMessage = g32Message({",
    "                  serviceId: extraServiceId,",
    "                  allocatorLineageId: extraTemplate.allocatorLineageId,",
    "                  tag: extraTag,",
    "                  attemptId: \"g73-calibration-attempt-\" + String(index) + \"-\" + String(g73RoundOffset + g73Round) + \"-\" + String(g73Operation),",
    "                  eventId: \"g73-calibration-event-\" + String(index) + \"-\" + String(g73RoundOffset + g73Round) + \"-\" + String(g73Operation),",
    "                  suid: g32SuidAt(deliveredAt, (g73RoundOffset + g73Round) * g73G69OperationsPerRound + g73Operation + 1),",
    "                  payload: extraTemplate.payload,",
    "                  eventTags: [extraTag],",
    "                  eventType: extraTemplate.eventType,",
    "                  enqueuedAt: deliveredAt - 100,",
    "                  obligationSequence: (g73RoundOffset + g73Round) * g73G69OperationsPerRound + g73Operation + 1,",
    "                });",
    '                await extraStore.recordDelivery(extraMessage, deliveredAt, "queue", {',
    "                  waitUntil: (promise: Promise<void>) => { extraWaiters.push(promise); },",
    "                });",
    "                await Promise.all(extraWaiters);",
    "              }",
    "            }",
    "            const g73ChunkDurationMs = " + clockDuration + ";",
    "            g73TimingChunks.push({",
    "              rounds: g73ChunkRounds,",
    "              operations: g73ChunkRounds * g73G69OperationsPerRound,",
    "              deliveryCount: g73ChunkRounds * g73G69OperationsPerRound,",
    "              durationMs: g73ChunkDurationMs,",
    "              waitersDrained: true,",
    "            });",
    "            g73RoundOffset += g73ChunkRounds;",
    ...directValidation,
    "          }",
    ...directTail,
    "        }",
  ].join("\n") + "\n";
}

function mutate(source, rounds, { directTiming = true } = {}) {
  const occurrences = source.split(mutationAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G67 AC3 G69-work mutation anchor expected once, found ${occurrences}`);
  }
  return source.replace(
    mutationAnchor,
    g69AddedWorkBlock(rounds, { directTiming }) + mutationAnchor,
  );
}

function legacyMutate(source, rounds) {
  const occurrences = source.split(mutationAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error("G67 AC3 legacy G69-work mutation anchor expected once, found " + occurrences);
  }
  return source.replace(
    mutationAnchor,
    legacyG69AddedWorkBlock(rounds) + mutationAnchor,
  );
}

function stripSgrSequences(value) {
  return String(value).replace(sgrSequencePattern, "");
}

function parseDirectTiming(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map(stripSgrSequences)
    .filter((line) => line.startsWith(directTimingMarker + " "));
  if (lines.length !== 1) {
    return {
      value: null,
      error: lines.length === 0
        ? "direct timing marker missing"
        : `direct timing marker must occur exactly once; found ${lines.length}`,
    };
  }
  const payload = lines[0].slice(directTimingMarker.length + 1);
  try {
    return { value: JSON.parse(payload), error: null };
  } catch (error) {
    return { value: null, error: String(error) };
  }
}

function runOracle(label, { retainReport = false } = {}) {
  const reportDirectory = mkdtempSync(resolve(tmpdir(), "sdt-g73-g67-"));
  const reportPath = resolve(reportDirectory, "vitest.json");
  const receiptPath = resolve(reportDirectory, "g80-receipt.json");
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [
    vitest, "run", "--config", "vitest.config.ts", "--no-cache",
    "--maxWorkers=1", testFile, "--testNamePattern", testName,
    "--reporter=json", "--reporter=verbose", "--reporter=./scripts/g80-vitest-receipt-reporter.mjs",
    "--outputFile", reportPath,
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "1",
      SDT_G80_OBSERVATION_ID: safeLabel(label),
      SDT_G80_RECEIPT_PATH: receiptPath,
      SDT_G80_TEST_TIMEOUT_MS: String(budgetMs),
    },
  });
  const processElapsedMs = Math.round(performance.now() - startedAt);
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  let report = null;
  let reportError = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    reportError = String(error);
  }
  let receipt = null;
  let receiptError = null;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    receiptError = String(error);
  }
  const targets = matchingTargetResults(report);
  const test = targets.length === 1 ? targets[0] : undefined;
  const receiptTargets = matchingReceiptTests(receipt);
  const receiptTarget = receiptTargets.length === 1 ? receiptTargets[0] : undefined;
  const installedVersion = installedVitestVersion();
  const receiptVersion = receipt?.vitestVersion ?? null;
  let reportRetentionPath = null;
  let receiptRetentionPath = null;
  if (retainReport) {
    ensureObservationRoot();
    const retainedPath = resolve(
      observationRoot,
      safeLabel(label) + "-" + process.pid + "-" + (reportCounter += 1) + ".json",
    );
    writeFileSync(retainedPath, JSON.stringify({
      metadata: receiptMetadata(),
      label,
      process: {
        status: result.status,
        signal: result.signal ?? null,
        error: result.error === undefined ? null : String(result.error),
      },
      report,
      receipt,
    }, null, 2), "utf8");
    reportRetentionPath = retainedPath;
    receiptRetentionPath = retainedPath;
  }
  const directTiming = parseDirectTiming(output);
  try {
    return {
      label,
      processStatus: result.status,
      signal: result.signal ?? null,
      spawnError: result.error === undefined ? null : String(result.error),
      processElapsedMs,
      bodyStatus: test?.status,
      bodyDurationMs: test?.duration,
      failureMessages: test?.failureMessages ?? receiptTarget?.errors?.map((error) => error.message).filter(Boolean) ?? [],
      targetCount: targets.length,
      receiptTargetCount: receiptTargets.length,
      reportTarget: test ?? null,
      receiptTarget,
      receiptFinalStatus: receipt?.finalStatus ?? null,
      vitestVersion: receiptVersion,
      receiptVitestVersion: receiptVersion,
      installedVitestVersion: installedVersion,
      receiptTests: receipt?.tests ?? [],
      collectionErrors: receipt?.collectionErrors ?? [],
      unhandledErrors: receipt?.unhandledErrors ?? [],
      reportError,
      receiptError,
      reportRetentionPath,
      receiptRetentionPath,
      directTiming: directTiming.value,
      directTimingError: directTiming.error,
      output,
    };
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function outcomeError(outcome, details) {
  const error = new Error(outcome + ": " + JSON.stringify(details));
  error.outcome = outcome;
  error.details = details;
  return error;
}

function requireHealthy(result) {
  if (
    result.processStatus === 0 &&
    result.signal === null &&
    result.spawnError === null &&
    result.reportError === null &&
    result.receiptError === null &&
    result.receiptFinalStatus === "passed" &&
    result.bodyStatus === "passed" &&
    result.targetCount === 1 &&
    result.receiptTargetCount === 1 &&
    result.receiptTarget?.state === "passed" &&
    pinnedVitestVersionMatches(result) &&
    Array.isArray(result.collectionErrors) && result.collectionErrors.length === 0 &&
    Array.isArray(result.unhandledErrors) && result.unhandledErrors.length === 0
  ) return;
  throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
    label: result.label,
    reason: "healthy oracle receipt is not a complete pinned-version named-target pass",
    rawObservation: oracleEvidence(result),
  });
}

function requireTimeoutRegression(result) {
  const timeoutMessage = "Test timed out in 10000ms.";
  const receiptErrors = Array.isArray(result.receiptTarget?.errors)
    ? result.receiptTarget.errors
    : [];
  const exactReceiptTimeout = receiptErrors.length === 1 &&
    receiptErrors[0]?.message?.split("\n", 1)[0] === timeoutMessage;
  const noOtherFailures = Array.isArray(result.receiptTests) &&
    result.receiptTests.filter((test) => test.state === "failed").length === 1;
  const isExactTargetTimeout =
    result.reportError === null &&
    result.receiptError === null &&
    result.targetCount === 1 &&
    result.receiptTargetCount === 1 &&
    result.receiptTarget?.state === "failed" &&
    typeof result.receiptTarget?.fullName === "string" &&
    result.receiptTarget.fullName.endsWith(testName) &&
    typeof result.processStatus === "number" &&
    result.processStatus !== 0 &&
    result.signal === null &&
    result.spawnError === null &&
    result.bodyStatus === "failed" &&
    result.receiptFinalStatus === "failed" &&
    Number.isFinite(result.bodyDurationMs) &&
    result.bodyDurationMs >= budgetMs &&
    exactReceiptTimeout &&
    noOtherFailures &&
    pinnedVitestVersionMatches(result) &&
    Array.isArray(result.collectionErrors) && result.collectionErrors.length === 0 &&
    Array.isArray(result.unhandledErrors) && result.unhandledErrors.length === 0;
  if (isExactTargetTimeout) return;
  throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
    label: result.label,
    reason: "representative did not produce exactly one named target timeout",
    rawObservation: oracleEvidence(result),
  });
}

function classifyRepresentativeResult(result) {
  try {
    requireTimeoutRegression(result);
    return { kind: "semantic-timeout" };
  } catch {
    // A clean pass of the exact named target is the only state that permits
    // another representative size. Every other state is fail-closed below.
  }
  try {
    requireHealthy(result);
    return { kind: "named-target-pass" };
  } catch {
    throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
      reason: "representative oracle state is neither an exact named-target pass nor an exact timeout",
      rawObservation: oracleEvidence(result),
    });
  }
}

function validateDirectTiming(timing) {
  const fail = (reason) => {
    throw new Error("G80 direct timing invalid: " + reason);
  };
  if (!timing || timing.clock !== "performance.now") {
    fail("the measured clock is not performance.now");
  }
  if (timing.timerOnly === true) fail("timer-only work was accepted");
  if (timing.skippedDeliveries !== 0) fail("deliveries were skipped");
  if (timing.omittedWaiterDrain === true) fail("waiters were not drained");
  if (timing.wrongCount === true) fail("delivery count was not exact");
  if (timing.waitersDrained !== true || timing.clockAdvancesDuringRealWork !== true) {
    fail("real delivery completion or clock advancement was not proven");
  }
  if (
    timing.initializationSeparated !== true ||
    !Number.isFinite(timing.initializationMs) ||
    timing.initializationMs < 0
  ) {
    fail("one-time store initialization was not measured separately");
  }
  if (
    timing.clockValidation?.probe !== "D1 SELECT 1" ||
    timing.clockValidation?.monotonic !== true ||
    timing.clockValidation?.samples !== directTimingPlan.clockProbeCount ||
    timing.clockValidation?.queriesPerSample !== directTimingPlan.clockProbeQueries ||
    !Number.isFinite(timing.clockValidation?.minAdvanceMs) ||
    timing.clockValidation.minAdvanceMs <= 0 ||
    !Number.isFinite(timing.clockValidation?.maxAdvanceMs) ||
    timing.clockValidation.maxAdvanceMs < timing.clockValidation.minAdvanceMs
  ) {
    fail("the selected clock was not positively observed around repeated D1 I/O probes");
  }
  if (timing.operationsPerRound !== g69OperationsPerRound) {
    fail("the operation cardinality changed");
  }
  if (
    timing.warmUpExcludedFromGates !== true ||
    timing.warmUpRounds !== directTimingPlan.warmUpRounds ||
    !Number.isFinite(timing.warmUpDurationMs) ||
    timing.warmUpDurationMs <= 0
  ) {
    fail("warm-up rounds were not measured separately and excluded from gates");
  }
  if (timing.scoringRounds !== directTimingPlan.scoringRounds) {
    fail("the scoring round count does not match the predeclared equal-size plan");
  }
  if (!Array.isArray(timing.chunks) || timing.chunks.length < 2) {
    fail("at least two direct timing batches are required");
  }
  const chunkSizes = new Set(timing.chunks.map((chunk) => chunk.rounds));
  if (chunkSizes.size !== 1) {
    fail("every scoring batch must use the same predeclared round count");
  }
  if (timing.chunks[0].rounds !== directTimingPlan.chunks[0]) {
    fail("scoring batch size does not match the predeclared equal-size plan");
  }
  const validChunks = timing.chunks.every((chunk) =>
    Number.isInteger(chunk.rounds) &&
    chunk.rounds > 0 &&
    chunk.operations === chunk.rounds * g69OperationsPerRound &&
    chunk.deliveryCount === chunk.rounds * g69OperationsPerRound &&
    chunk.waitersDrained === true &&
    Number.isFinite(chunk.durationMs) &&
    chunk.durationMs > 0
  );
  if (!validChunks) fail("a batch lacks complete positive-cost delivery evidence");
  const totalRounds = timing.chunks.reduce((sum, chunk) => sum + chunk.rounds, 0);
  if (totalRounds !== timing.totalRounds) {
    fail("the batch rounds do not cover the declared total");
  }
  if (!Number.isFinite(timing.minObservedAdvanceMs) || timing.minObservedAdvanceMs <= 0) {
    fail("the hosted clock did not show a positive finite interval");
  }
  return timing;
}

function deriveAllowance(timing) {
  const costs = timing.chunks.map((chunk) => chunk.durationMs / chunk.rounds);
  const referenceRateMs = median(costs);
  const observedRateSpread = {
    observedMinMs: Math.min(...costs),
    observedMaxMs: Math.max(...costs),
    referenceRateMs,
  };
  const pairedResiduals = [];
  for (let index = 0; index < timing.chunks.length; index += 1) {
    for (let next = index + 1; next < timing.chunks.length; next += 1) {
      if (timing.chunks[index].rounds === timing.chunks[next].rounds) {
        pairedResiduals.push(Math.abs(costs[index] - costs[next]));
      }
    }
  }
  if (pairedResiduals.length === 0) {
    throw outcomeError("CALIBRATION_INCONCLUSIVE", {
      reason: "no matched repeated batch exists for a residual allowance",
    });
  }
  const residualRangeMs = {
    min: Math.min(...pairedResiduals),
    max: Math.max(...pairedResiduals),
  };
  if (residualRangeMs.max > equalSizeResidualBoundMs) {
    throw outcomeError("CALIBRATION_INCONCLUSIVE", {
      reason: "the equal-size residual escaped the predeclared same-unit bound",
      equalSizeResidualBoundMs,
      residualRangeMs,
      pairedResidualsMs: pairedResiduals,
      costsPerRoundMs: costs,
    });
  }
  const madMs = medianAbsoluteDeviation(pairedResiduals);
  const allowanceMs = Math.max(
    timerResolutionFloorMs,
    median(pairedResiduals) + allowanceMadFactor * madMs,
  );
  return {
    costsPerRoundMs: costs,
    pairedResidualsMs: pairedResiduals,
    residualRangeMs,
    equalSizeResidualBoundMs,
    madMs,
    timerResolutionFloorMs,
    allowanceMadFactor,
    allowanceMs,
    observedRateSpread,
    directRateLowerBoundMs: Math.min(...costs),
    directRateMedianMs: referenceRateMs,
  };
}

function decideCalibration(healthy, calibration) {
  const invalidReceiptDetails = calibrationFailureDetails(healthy, calibration, {
    reason: "calibration report, receipt, version or direct timing marker was missing/malformed",
  });
  if (
    calibration.reportError !== null ||
    calibration.targetCount !== 1 ||
    calibration.directTimingError !== null ||
    calibration.directTiming === null ||
    !pinnedVitestVersionMatches(calibration)
  ) {
    throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", invalidReceiptDetails);
  }
  let timing;
  try {
    timing = validateDirectTiming(calibration.directTiming);
  } catch (error) {
    throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", calibrationFailureDetails(healthy, calibration, {
      reason: "calibration direct timing failed validation",
      validationError: String(error?.message ?? error),
    }));
  }
  const signedDifferenceMs = calibration.bodyDurationMs - healthy.bodyDurationMs;
  let allowance;
  try {
    allowance = deriveAllowance(timing);
  } catch (error) {
    if (error?.outcome === "CALIBRATION_INCONCLUSIVE") {
      error.details = calibrationFailureDetails(healthy, calibration, error.details);
    }
    throw error;
  }
  const directRateLowerBoundMs = allowance.directRateLowerBoundMs;
  const directRateMedianMs = allowance.directRateMedianMs;
  const scalingRatio = allowance.observedRateSpread.observedMaxMs /
    allowance.observedRateSpread.observedMinMs;
  // Representative sizing and the acceptance gate use only the direct
  // per-round lower bound.  Whole-test timing is retained below as an
  // attribution diagnostic and is deliberately never compared with the
  // per-round allowance.
  const predictedAddedWorkMs = directRateLowerBoundMs * calibrationRounds;
  const wholeTestAttributionRatio = Number.isFinite(signedDifferenceMs) && predictedAddedWorkMs > 0
    ? signedDifferenceMs / predictedAddedWorkMs
    : null;
  if (!Number.isFinite(directRateLowerBoundMs) || directRateLowerBoundMs <= allowance.allowanceMs) {
    throw outcomeError("CALIBRATION_INCONCLUSIVE", calibrationFailureDetails(healthy, calibration, {
      reason: "the direct per-round lower bound did not dominate the predeclared per-round allowance",
      comparison: "directRateLowerBoundMs > allowanceMs",
      directRateLowerBoundMs,
      directRateMedianMs,
      allowanceMs: allowance.allowanceMs,
      signedDifferenceMs,
      allowance,
      predictedAddedWorkMs,
      wholeTestAttributionRatio,
      timing,
    }));
  }
  return {
    timing,
    allowance,
    signedDifferenceMs,
    directPerRoundMs: directRateLowerBoundMs,
    directRateLowerBoundMs,
    directRateMedianMs,
    directSignalDominatesAllowance: true,
    predictedAddedWorkMs,
    wholeTestAttributionRatio,
    scalingRatio,
    // Compatibility field for retained receipts; it is diagnostic only.
    predictionRatio: wholeTestAttributionRatio,
    decisionPath: {
      directMeasurement: "bounded performance.now per-round delivery timing",
      warmUpExcludedFromGates: true,
      equalSizePlanOnly: true,
      equalSizeResidualBound: "passed",
      directSignal: "lower-bound dominates same-unit allowance",
      scalingRatio,
      wholeTestDifference: "attribution-only",
    },
  };
}

function legacyObservationRecord(pairIndex, healthy, calibration) {
  const healthyBodyMs = healthy.bodyDurationMs;
  const calibrationBodyMs = calibration.bodyDurationMs;
  const rawAddedWorkPerRoundMs =
    Number.isFinite(healthyBodyMs) && Number.isFinite(calibrationBodyMs)
      ? (calibrationBodyMs - healthyBodyMs) / calibrationRounds
      : null;
  const legacyClampedCostMs =
    rawAddedWorkPerRoundMs === null
      ? null
      : rawAddedWorkPerRoundMs < 1
        ? 1
        : rawAddedWorkPerRoundMs;
  return {
    pairIndex,
    healthyObservation: oracleEvidence(healthy),
    calibrationObservation: oracleEvidence(calibration),
    signedDifferenceMs:
      Number.isFinite(healthyBodyMs) && Number.isFinite(calibrationBodyMs)
        ? calibrationBodyMs - healthyBodyMs
        : null,
    rawAddedWorkPerRoundMs,
    legacyClampedCostMs,
    sourceRunnerSha256: originalRunnerSha256,
    estimator: "pre-G80 clamped raw-difference/32 behavior, observation-only",
  };
}

function emitObservation(record) {
  return emitDurableRecord(durableRecordPrefix, {
    schema: durableRecordSchema,
    recordType: "observation-input",
    observationId: `g80-observation-pair-${record.pairIndex}`,
    stageId: `g80-observation-pair-${record.pairIndex}:input`,
    stage: "observation-input",
    metadata: receiptMetadata(),
    record,
  });
}

function observationOnly(sourcePath, original) {
  const requestedPairsArg = process.argv.find((argument) => argument.startsWith("--pairs="));
  const requestedPairs = requestedPairsArg === undefined
    ? 5
    : Number(requestedPairsArg.slice("--pairs=".length));
  if (!Number.isInteger(requestedPairs) || requestedPairs < 1) {
    throw new Error("G80 observation pairs must be a positive integer");
  }
  const records = [];
  const observationStages = [];
  ensureObservationRoot();
  for (let pairIndex = 1; pairIndex <= requestedPairs; pairIndex += 1) {
    const healthy = runOracle(
      "g80-observation-pair-" + pairIndex + "-healthy",
      { retainReport: true },
    );
    writeFileSync(sourcePath, legacyMutate(original, calibrationRounds), "utf8");
    const calibration = runOracle(
      "g80-observation-pair-" + pairIndex + "-calibration",
      { retainReport: true },
    );
    writeFileSync(sourcePath, original, "utf8");
    const record = legacyObservationRecord(pairIndex, healthy, calibration);
    records.push(record);
    observationStages.push(emitObservation(record));
  }
  const summary = createDurableSummary(observationStages, {
    observationId: "g80-observation-only",
    metadata: receiptMetadata(),
    predeclaredPairs: requestedPairs,
    requiredFreshHostedJobInstances: true,
    originalRunnerSha256,
    missingOrFailedPairs: records.filter((record) =>
      record.healthyObservation?.process?.status !== 0 ||
      record.healthyObservation?.body?.status !== "passed" ||
      record.calibrationObservation?.process?.status !== 0 ||
      record.calibrationObservation?.body?.status !== "passed"
    ).map((record) => record.pairIndex),
    note: "A local invocation cannot claim fresh hosted job separation; hosted receipts remain required evidence.",
  });
  writeFileSync(
    resolve(observationRoot, "summary-" + process.pid + ".json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  process.stdout.write(durableRecordLine(durableSummaryPrefix, summary) + "\n");
}

function representativeRoundsFor(healthyBodyMs, calibrationDecision) {
  const healthyMarginMs = budgetMs - healthyBodyMs;
  if (!Number.isFinite(healthyMarginMs) || healthyMarginMs <= 0) {
    throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
      reason: "healthy G67 body did not leave a positive budget margin",
      healthyBodyMs,
      budgetMs,
    });
  }
  const directRateLowerBoundMs = calibrationDecision.directRateLowerBoundMs ?? calibrationDecision.directPerRoundMs;
  const estimatedRounds = Math.ceil(
    (healthyMarginMs / directRateLowerBoundMs) * safetyFactor,
  );
  const representativeRounds = Math.max(
    calibrationRounds + 1,
    estimatedRounds,
  );
  if (representativeRounds > maxRepresentativeRounds) {
    throw outcomeError("REPRESENTATIVE_RANGE_EXCEEDED", {
      representativeRounds,
      maxRepresentativeRounds,
      safetyFactor,
      directRateLowerBoundMs,
      directPerRoundMs: calibrationDecision.directPerRoundMs,
    });
  }
  return { healthyMarginMs, representativeRounds };
}

function runStructuredTimeoutReceiptSelfTest() {
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  const directory = mkdtempSync(resolve(root, ".artifacts", "sdt-g80-reporter-self-test-"));
  const testPath = resolve(directory, "g80-receipt-timeout.test.mjs");
  const receiptPath = resolve(directory, "receipt.json");
  writeFileSync(testPath, [
    'import { it } from "vitest";',
    'it("G80 reporter timeout conformance", async () => { await new Promise(() => {}); }, 10);',
    "",
  ].join("\n"), "utf8");
  let result;
  let receipt;
  try {
    result = spawnSync(process.execPath, [
      vitest, "run", "--config", "vitest.g24-deploy.config.ts", "--no-cache",
      testPath, "--testTimeout=10", "--reporter=./scripts/g80-vitest-receipt-reporter.mjs",
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        CI: "1",
        SDT_G80_RECEIPT_PATH: receiptPath,
        SDT_G80_TEST_TIMEOUT_MS: "10",
      },
    });
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const tests = Array.isArray(receipt?.tests) ? receipt.tests : [];
  const target = tests.filter((test) => test.fullName === "G80 reporter timeout conformance");
  const firstMessage = target[0]?.errors?.[0]?.message?.split("\n", 1)[0];
  if (
    result?.status === 0 ||
    result?.signal !== null ||
    receipt?.finalStatus !== "failed" ||
    receipt?.vitestVersion !== pinnedVitestVersion ||
    installedVitestVersion() !== pinnedVitestVersion ||
    target.length !== 1 ||
    target[0]?.state !== "failed" ||
    target[0]?.configuredTimeoutMs !== 10 ||
    firstMessage !== "Test timed out in 10ms."
  ) {
    throw new Error("G80 structured reporter did not capture the real Vitest timeout: " + JSON.stringify({
      processStatus: result?.status,
      signal: result?.signal,
      processError: result?.error === undefined ? null : String(result.error),
      receipt,
      output: `${result?.stdout ?? ""}${result?.stderr ?? ""}`,
    }));
  }
  return {
    processStatus: result.status,
    signal: result.signal ?? null,
    vitestVersion: receipt.vitestVersion,
    target: compactTarget(target[0]),
    receiptFinalStatus: receipt.finalStatus,
  };
}

function runDurableRecordSelfTest() {
  const selfTestMetadata = {
    workflow: "self-test-workflow",
    runId: "self-test-run",
    runAttempt: "1",
    job: "self-test-job",
    immutableHead: "self-test-head",
  };
  const observation = ({ status, durationMs, directTiming, directTimingError = null }) => ({
    label: "self-test-observation",
    process: { status, signal: null, spawnError: null, elapsedMs: 20.125 },
    body: { status, durationMs },
    target: {
      reportCount: 1,
      receiptCount: 1,
      report: { module: testFile, fullName: testName, state: status, durationMs, errors: [] },
      receipt: { module: testFile, fullName: testName, state: status, durationMs, errors: [] },
      failedTestCount: status === "failed" ? 1 : 0,
    },
    versions: { report: pinnedVitestVersion, receipt: pinnedVitestVersion, installed: pinnedVitestVersion },
    receiptFinalStatus: status,
    failureMessages: status === "failed" ? ["Test timed out in 10000ms."] : [],
    collectionErrors: [],
    unhandledErrors: [],
    reportError: null,
    receiptError: null,
    directTiming,
    directTimingError,
  });
  const directTiming = {
    clock: "performance.now",
    initializationMs: 1.25,
    clockValidation: { probe: "D1 SELECT 1", samples: 3, queriesPerSample: 32, minAdvanceMs: 0.125, maxAdvanceMs: 0.375, monotonic: true },
    chunks: [{ rounds: 4, operations: 8, deliveryCount: 8, durationMs: 40.5, waitersDrained: true }],
    totalRounds: 4,
    operationsPerRound: 2,
    waitersDrained: true,
    skippedDeliveries: 0,
    omittedWaiterDrain: false,
    wrongCount: false,
    timerOnly: false,
    clockAdvancesDuringRealWork: true,
    minObservedAdvanceMs: 40.5,
  };
  const healthyStage = createDurableRecord({
    schema: durableRecordSchema,
    recordType: "stage",
    observationId: "self-test-success",
    stageId: "self-test-success:healthy:1",
    stage: "healthy",
    metadata: selfTestMetadata,
    observation: observation({ status: "passed", durationMs: 123.456, directTiming: null }),
  });
  const calibrationStage = createDurableRecord({
    schema: durableRecordSchema,
    recordType: "stage",
    observationId: "self-test-success",
    stageId: "self-test-success:calibration:2",
    stage: "calibration",
    metadata: selfTestMetadata,
    observation: observation({ status: "passed", durationMs: 234.567, directTiming }),
  });
  const representativeStage = createDurableRecord({
    schema: durableRecordSchema,
    recordType: "stage",
    observationId: "self-test-success",
    stageId: "self-test-success:representative:3",
    stage: "representative-attempt",
    metadata: selfTestMetadata,
    rounds: 512,
    observation: observation({ status: "failed", durationMs: 10_001.125, directTiming: null }),
  });
  const successSummary = createDurableSummary(
    [healthyStage, calibrationStage, representativeStage],
    {
      observationId: "self-test-success",
      metadata: selfTestMetadata,
      outcome: "healthy-green-g69-path-timeout-red",
      disposition: "exact-named-target-timeout",
      directTiming,
      allowanceInputs: { lowerMs: 5.25, upperMs: 21, equalSizeResidualBoundMs: 10 },
      wholeTestAttribution: { signedDifferenceMs: 111.111, unit: "whole-test-ms-attribution-only" },
      representativeSelection: { status: "selected", rounds: 512, source: "conservative direct per-round lower bound" },
      attempts: [recordReference(representativeStage)],
      semanticTimeout: { status: "exact-named-target-timeout", expected: "Test timed out in 10000ms.", received: "Test timed out in 10000ms." },
    },
  );
  const successLines = [
    durableRecordLine(durableRecordPrefix, healthyStage),
    durableRecordLine(durableRecordPrefix, calibrationStage),
    durableRecordLine(durableRecordPrefix, representativeStage),
    durableRecordLine(durableSummaryPrefix, successSummary),
  ];
  const reconstructedSuccess = reconstructDurableRecords(successLines);
  if (
    reconstructedSuccess.stages.length !== 3 ||
    reconstructedSuccess.summary.outcome !== "healthy-green-g69-path-timeout-red" ||
    reconstructedSuccess.summary.directTiming.chunks.length !== 1 ||
    reconstructedSuccess.summary.wholeTestAttribution.unit !== "whole-test-ms-attribution-only" ||
    reconstructedSuccess.summary.attempts.length !== 1 ||
    reconstructedSuccess.summary.semanticTimeout.status !== "exact-named-target-timeout"
  ) {
    throw new Error("G80 durable success record reconstruction dropped required AC6 fields");
  }

  const failureStage = createDurableRecord({
    schema: durableRecordSchema,
    recordType: "stage",
    observationId: "self-test-failure",
    stageId: "self-test-failure:calibration:1",
    stage: "calibration",
    metadata: selfTestMetadata,
    observation: observation({
      status: null,
      durationMs: null,
      directTiming: null,
      directTimingError: "direct timing marker missing",
    }),
  });
  const failureSummary = createDurableSummary([failureStage], {
    observationId: "self-test-failure",
    metadata: selfTestMetadata,
    outcome: "HEALTHY_OR_ORACLE_FAILURE",
    disposition: "fail-closed",
    directTiming: null,
    allowanceInputs: null,
    wholeTestAttribution: { signedDifferenceMs: null, unit: "whole-test-ms-attribution-only" },
    representativeSelection: "not-reached",
    attempts: [],
    semanticTimeout: "not-reached",
    failure: {
      process: { status: 1, signal: null, error: "named target receipt missing" },
      target: { reportCount: 0, receiptCount: 0 },
      version: { expected: pinnedVitestVersion, receipt: null, installed: pinnedVitestVersion },
      body: { status: null, durationMs: null },
      directTimingError: "direct timing marker missing",
    },
  });
  const failureLines = [
    durableRecordLine(durableRecordPrefix, failureStage),
    durableRecordLine(durableSummaryPrefix, failureSummary),
  ];
  const reconstructedFailure = reconstructDurableRecords(failureLines);
  if (
    reconstructedFailure.summary.outcome !== "HEALTHY_OR_ORACLE_FAILURE" ||
    reconstructedFailure.summary.disposition !== "fail-closed" ||
    reconstructedFailure.summary.representativeSelection !== "not-reached" ||
    reconstructedFailure.summary.semanticTimeout !== "not-reached" ||
    reconstructedFailure.summary.failure.directTimingError !== "direct timing marker missing"
  ) {
    throw new Error("G80 durable failure record reconstruction dropped fail-closed evidence");
  }

  const expectReconstructionFailure = (name, candidateLines) => {
    try {
      reconstructDurableRecords(candidateLines);
    } catch {
      return;
    }
    throw new Error("G80 durable self-test accepted invalid " + name);
  };
  const tamperedSuccess = JSON.parse(successLines[1].slice(durableRecordPrefix.length + 1));
  tamperedSuccess.observation.body.durationMs = 999;
  expectReconstructionFailure("tampered digest", [
    successLines[0],
    durableRecordLine(durableRecordPrefix, tamperedSuccess),
    successLines[2],
    successLines[3],
  ]);
  expectReconstructionFailure("missing stage", successLines.filter((line) => !line.includes(calibrationStage.stageId)));
  expectReconstructionFailure("unrelated line", [...successLines, "Vitest output without a durable receipt"]);
  const oversized = createDurableRecord({
    schema: durableRecordSchema,
    recordType: "stage",
    observationId: "self-test-overflow",
    stageId: "self-test-overflow:stage:1",
    stage: "overflow",
    metadata: selfTestMetadata,
    payload: "x".repeat(maxDurableRecordBytes),
  });
  let overlongRejected = false;
  try {
    durableRecordLine(durableRecordPrefix, oversized);
  } catch {
    overlongRejected = true;
  }
  if (!overlongRejected) throw new Error("G80 durable self-test accepted an overlong line");
  const maxSuccessLineBytes = Math.max(...successLines.map((line) => Buffer.byteLength(line, "utf8")));
  const maxFailureLineBytes = Math.max(...failureLines.map((line) => Buffer.byteLength(line, "utf8")));
  return {
    schema: durableRecordSchema,
    maxBytes: maxDurableRecordBytes,
    successRecordCount: successLines.length,
    failureRecordCount: failureLines.length,
    maxSuccessLineBytes,
    maxFailureLineBytes,
    successReconstruction: "passed",
    failureReconstruction: "passed",
    tamperedDigest: "rejected",
    missingStage: "rejected",
    overlongLine: "rejected",
  };
}

function selfTest() {
  const source = readFileSync(resolve(root, testFile), "utf8");
  const mutated = mutate(source, directMutationRoundsTotal());
  if (!mutated.includes('extraStore.recordDelivery(extraMessage, deliveredAt, "queue"')) {
    throw new Error("G67 self-test does not exercise the real D1EventStore G69 path");
  }
  if (!mutated.includes("if (index === 1)")) {
    throw new Error("G67 self-test does not bound calibration work to one real paced commit");
  }
  if (!mutated.includes("const extraMessage = g32Message({") || !mutated.includes("g32SuidAt(deliveredAt") ||
      !mutated.includes("const g73G69OperationsPerRound = 2")) {
    throw new Error("G67 self-test does not create unique valid real-path calibration envelopes");
  }
  if (mutated.includes("setTimeout(resolve, 9500)") || mutated.includes("process.hrtime.bigint")) {
    throw new Error("G67 self-test retained an unsupported timer or process-clock proof");
  }
  const directSection = mutated.slice(
    mutated.indexOf("// G80 direct-timing mutant"),
    mutated.indexOf(mutationAnchor),
  );
  if (!directSection.includes("performance.now()") ||
      directSection.includes("Date.now()") ||
      directSection.includes("process.hrtime")) {
    throw new Error("G80 direct timing did not use only the intended Vitest-body clock seam");
  }
  const validTiming = {
    clock: "performance.now",
    clockValidation: {
      probe: "D1 SELECT 1",
      samples: directTimingPlan.clockProbeCount,
      queriesPerSample: directTimingPlan.clockProbeQueries,
      minAdvanceMs: 0.1,
      maxAdvanceMs: 0.3,
      monotonic: true,
    },
    initializationMs: 0,
    initializationSeparated: true,
    warmUpRounds: directTimingPlan.warmUpRounds,
    warmUpDurationMs: 128,
    warmUpExcludedFromGates: true,
    chunks: directTimingPlan.chunks.map((rounds, index) => ({
      rounds,
      operations: rounds * g69OperationsPerRound,
      deliveryCount: rounds * g69OperationsPerRound,
      durationMs: rounds * (index === directTimingPlan.chunks.length - 1 ? 11 : 10),
      waitersDrained: true,
    })),
    scoringRounds: directTimingPlan.scoringRounds,
    totalRounds: directTimingPlan.scoringRounds,
    operationsPerRound: 2,
    waitersDrained: true,
    skippedDeliveries: 0,
    omittedWaiterDrain: false,
    wrongCount: false,
    timerOnly: false,
    clockAdvancesDuringRealWork: true,
    minObservedAdvanceMs: 80,
  };
  const colourPrefixedTiming = parseDirectTiming(
    "\u001b[22m\u001b[39m" + directTimingMarker + " " + JSON.stringify(validTiming),
  );
  if (
    colourPrefixedTiming.error !== null ||
    JSON.stringify(colourPrefixedTiming.value) !== JSON.stringify(validTiming)
  ) {
    throw new Error("G80 self-test did not strip SGR before matching the direct timing marker");
  }
  const truncatedMarker = parseDirectTiming(
    directTimingMarker.slice(0, -1) + " " + JSON.stringify(validTiming),
  );
  if (truncatedMarker.value !== null || truncatedMarker.error === null) {
    throw new Error("G80 self-test accepted a truncated direct timing marker");
  }
  const truncatedPayload = parseDirectTiming(
    directTimingMarker + ' {"clock":"performance.now"',
  );
  if (truncatedPayload.value !== null || truncatedPayload.error === null) {
    throw new Error("G80 self-test accepted a truncated direct timing payload");
  }
  const missingMarker = parseDirectTiming("Vitest output without the direct timing receipt");
  if (missingMarker.value !== null || missingMarker.error === null) {
    throw new Error("G80 self-test accepted output with a missing direct timing marker");
  }
  const duplicateMarker = parseDirectTiming(
    [
      directTimingMarker + " " + JSON.stringify(validTiming),
      directTimingMarker + " " + JSON.stringify(validTiming),
    ].join("\n"),
  );
  if (duplicateMarker.value !== null || duplicateMarker.error === null) {
    throw new Error("G80 self-test accepted more than one direct timing marker");
  }
  if (!directSection.includes("g73WarmUpRounds") || !directSection.includes("g73WarmUpDurationMs")) {
    throw new Error("G90 direct timing did not emit a separated warm-up phase");
  }
  validateDirectTiming(validTiming);
  const validAllowance = deriveAllowance(validTiming);
  if (
    validAllowance.directRateLowerBoundMs !== 10 ||
    validAllowance.directRateMedianMs !== 10 ||
    validAllowance.allowanceMs !== 1 ||
    validAllowance.observedRateSpread.observedMinMs !== 10 ||
    validAllowance.observedRateSpread.observedMaxMs !== 11 ||
    validAllowance.equalSizeResidualBoundMs !== equalSizeResidualBoundMs
  ) {
    throw new Error("G90 self-test did not retain the census-backed direct-rate/residual bounds");
  }
  const timingWithRates = (rates) => ({
    ...validTiming,
    chunks: validTiming.chunks.map((chunk, index) => ({
      ...chunk,
      durationMs: chunk.rounds * rates[index],
    })),
  });
  const expectAllowanceRejection = (name, timing, expectedReason) => {
    try {
      deriveAllowance(timing);
    } catch (error) {
      if (
        error?.outcome === "CALIBRATION_INCONCLUSIVE" &&
        error?.details?.reason === expectedReason
      ) return;
      throw new Error("G90 self-test rejected " + name + " for the wrong reason: " + String(error));
    }
    throw new Error("G90 self-test accepted " + name);
  };
  expectAllowanceRejection(
    "equal-size residual mutant",
    timingWithRates([8, 10, 18, 8, 8]),
    "the equal-size residual escaped the predeclared same-unit bound",
  );
  let warmUpOmissionRejected = false;
  try {
    validateDirectTiming({ ...validTiming, warmUpExcludedFromGates: false });
  } catch {
    warmUpOmissionRejected = true;
  }
  if (!warmUpOmissionRejected) {
    throw new Error("G90 self-test accepted warm-up omission");
  }
  const warmUpDigest = canonicalDigest({
    ...stripRecordDigests(createDurableRecord({
      schema: durableRecordSchema,
      warmUpDurationMs: validTiming.warmUpDurationMs,
    })),
  });
  const omittedWarmUpDigest = canonicalDigest({
    ...stripRecordDigests(createDurableRecord({
      schema: durableRecordSchema,
      warmUpDurationMs: null,
    })),
  });
  if (warmUpDigest === omittedWarmUpDigest) {
    throw new Error("G90 self-test did not change the digest when warm-up was omitted");
  }
  let mixedChunkRejected = false;
  try {
    validateDirectTiming({
      ...validTiming,
      chunks: [
        { rounds: 8, operations: 16, deliveryCount: 16, durationMs: 80, waitersDrained: true },
        { rounds: 4, operations: 8, deliveryCount: 8, durationMs: 40, waitersDrained: true },
      ],
      scoringRounds: 12,
      totalRounds: 12,
    });
  } catch {
    mixedChunkRejected = true;
  }
  if (!mixedChunkRejected) {
    throw new Error("G90 self-test accepted mixed-size scoring chunks");
  }
  const invalidTimingCases = [
    ["mocked/frozen clock", { clock: "Date.now" }],
    ["zero duration", { chunks: validTiming.chunks.map((chunk, index) => index === 0 ? { ...chunk, durationMs: 0 } : chunk) }],
    ["nonfinite duration", { chunks: validTiming.chunks.map((chunk, index) => index === 0 ? { ...chunk, durationMs: Number.NaN } : chunk) }],
    ["skipped deliveries", { skippedDeliveries: 1 }],
    ["omitted waiter drain", { omittedWaiterDrain: true }],
    ["wrong count", { wrongCount: true }],
    ["timer-only workload", { timerOnly: true }],
  ];
  for (const [name, changes] of invalidTimingCases) {
    let rejected = false;
    try {
      validateDirectTiming({ ...validTiming, ...changes });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("G80 self-test accepted invalid timing case: " + name);
  }
  const validTimeoutReceipt = {
    label: "self-test representative",
    reportError: null,
    receiptError: null,
    targetCount: 1,
    receiptTargetCount: 1,
    processStatus: 1,
    signal: null,
    spawnError: null,
    bodyStatus: "failed",
    bodyDurationMs: 10_001,
    receiptFinalStatus: "failed",
    vitestVersion: pinnedVitestVersion,
    receiptVitestVersion: pinnedVitestVersion,
    installedVitestVersion: pinnedVitestVersion,
    receiptTarget: {
      module: testFile,
      fullName: testName,
      state: "failed",
      errors: [{ name: "Error", message: "Test timed out in 10000ms.", stack: "Error: Test timed out in 10000ms." }],
    },
    receiptTests: [{ module: testFile, fullName: testName, state: "failed", errors: [{ message: "Test timed out in 10000ms." }] }],
    collectionErrors: [],
    unhandledErrors: [],
    failureMessages: ["Test timed out in 10000ms."],
    output: "",
  };
  requireTimeoutRegression(validTimeoutReceipt);
  const w226Fixture = JSON.parse(readFileSync(
    resolve(root, "scripts/fixtures/g80-w226-stack-trace-error.json"),
    "utf8",
  ));
  const w226StackTraceShape = {
    ...validTimeoutReceipt,
    vitestVersion: w226Fixture.vitestVersion,
    receiptVitestVersion: w226Fixture.vitestVersion,
    receiptTarget: w226Fixture.tests[0],
    receiptTests: w226Fixture.tests,
    receiptFinalStatus: w226Fixture.finalStatus,
  };
  const invalidTimeoutReceipts = [
    ["hook timeout", {
      ...validTimeoutReceipt,
      receiptTarget: {
        ...validTimeoutReceipt.receiptTarget,
        errors: [{ name: "Error", message: "Hook timed out in 10000ms.", stack: "Error: Hook timed out in 10000ms." }],
      },
    }],
    ["selected-target assertion", {
      ...validTimeoutReceipt,
      receiptTarget: {
        ...validTimeoutReceipt.receiptTarget,
        errors: [{ name: "AssertionError", message: "expected 32 to be 31", stack: "AssertionError: expected 32 to be 31" }],
      },
    }],
    ["mixed timeout and assertion messages", {
      ...validTimeoutReceipt,
      receiptTarget: {
        ...validTimeoutReceipt.receiptTarget,
        errors: [
          { name: "Error", message: "Test timed out in 10000ms.", stack: "Error: Test timed out in 10000ms." },
          { name: "AssertionError", message: "expected 32 to be 31", stack: "AssertionError: expected 32 to be 31" },
        ],
      },
    }],
    ["other failed target", {
      ...validTimeoutReceipt,
      receiptTests: [
        ...validTimeoutReceipt.receiptTests,
        { module: "test/other.spec.ts", fullName: "other failed target", state: "failed", errors: [{ message: "unrelated" }] },
      ],
    }],
    ["duplicate selected target", {
      ...validTimeoutReceipt,
      targetCount: 2,
      receiptTargetCount: 2,
      receiptTarget: undefined,
      receiptTests: [validTimeoutReceipt.receiptTests[0], validTimeoutReceipt.receiptTests[0]],
    }],
    ["output-only fabricated timeout", {
      ...validTimeoutReceipt,
      targetCount: 0,
      receiptTargetCount: 0,
      receiptTarget: undefined,
      receiptTests: [],
      output: "Test timed out in 10000ms.",
    }],
    ["sanitized W226 STACK_TRACE_ERROR", w226StackTraceShape],
    ["signal termination", { ...validTimeoutReceipt, signal: "SIGTERM" }],
    ["missing target", { ...validTimeoutReceipt, targetCount: 0, receiptTargetCount: 0, receiptTarget: undefined }],
    ["setup/import failure", { ...validTimeoutReceipt, collectionErrors: [{ message: "Failed to load setup file" }] }],
    ["unhandled error", { ...validTimeoutReceipt, unhandledErrors: [{ message: "unhandled" }] }],
    ["green target", { ...validTimeoutReceipt, bodyStatus: "passed", receiptFinalStatus: "passed", receiptTarget: { ...validTimeoutReceipt.receiptTarget, state: "passed", errors: [] }, receiptTests: [{ ...validTimeoutReceipt.receiptTests[0], state: "passed", errors: [] }] }],
    ["wrong timeout message", { ...validTimeoutReceipt, failureMessages: ["Test timed out in 5000ms."], receiptTarget: { ...validTimeoutReceipt.receiptTarget, errors: [{ name: "Error", message: "Test timed out in 5000ms." }] } }],
    ["incomplete process", { ...validTimeoutReceipt, processStatus: null }],
    ["spawn error", { ...validTimeoutReceipt, spawnError: "spawn failed" }],
    ["missing Vitest version", { ...validTimeoutReceipt, receiptVitestVersion: null }],
    ["wrong Vitest version", { ...validTimeoutReceipt, receiptVitestVersion: "4.1.9" }],
  ];
  for (const [name, rejectedReceipt] of invalidTimeoutReceipts) {
    let rejected = false;
    try {
      requireTimeoutRegression(rejectedReceipt);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("G80 self-test accepted an invalid timeout receipt: " + name);
  }
  const validNamedPass = {
    ...validTimeoutReceipt,
    processStatus: 0,
    bodyStatus: "passed",
    bodyDurationMs: 2_000,
    receiptFinalStatus: "passed",
    receiptTarget: {
      ...validTimeoutReceipt.receiptTarget,
      state: "passed",
      errors: [],
    },
    receiptTests: [{
      ...validTimeoutReceipt.receiptTests[0],
      state: "passed",
      errors: [],
    }],
    failureMessages: [],
  };
  if (classifyRepresentativeResult(validNamedPass).kind !== "named-target-pass") {
    throw new Error("G80 self-test did not classify a valid named-target pass");
  }
  let simulatedRepresentativeInvocations = 0;
  let immediateStop = false;
  try {
    simulatedRepresentativeInvocations += 1;
    classifyRepresentativeResult({
      ...validNamedPass,
      signal: "SIGTERM",
      processStatus: null,
      bodyStatus: undefined,
      receiptFinalStatus: null,
      receiptTarget: undefined,
      receiptTargetCount: 0,
      targetCount: 0,
    });
    simulatedRepresentativeInvocations += 1;
    classifyRepresentativeResult(validNamedPass);
  } catch (error) {
    immediateStop = error?.outcome === "HEALTHY_OR_ORACLE_FAILURE";
  }
  if (!immediateStop || simulatedRepresentativeInvocations !== 1) {
    throw new Error("G80 self-test permitted escalation after an invalid representative observation");
  }
  let unitMismatchMutant = false;
  try {
    const unitMismatchDecision = decideCalibration(
      { bodyDurationMs: 100, label: "healthy" },
      {
        label: "calibration",
        reportError: null,
        targetCount: 1,
        directTimingError: null,
        directTiming: validTiming,
        receiptVitestVersion: pinnedVitestVersion,
        installedVitestVersion: pinnedVitestVersion,
        // The whole-test interval is a sub-allowance attribution in this fixture;
        // it must not be compared to the positive ms/round allowance.
        bodyDurationMs: 100.5,
      },
    );
    unitMismatchMutant =
      unitMismatchDecision.signedDifferenceMs === 0.5 &&
      unitMismatchDecision.directRateLowerBoundMs === 10 &&
      unitMismatchDecision.decisionPath.wholeTestDifference === "attribution-only";
  } catch (error) {
    throw new Error("G80 unit-mismatch mutant was incorrectly rejected: " + String(error));
  }
  if (!unitMismatchMutant) throw new Error("G80 self-test did not prove whole-test attribution is non-authoritative");
  let inconclusiveDirectSignal = false;
  let inconclusiveDirectDetails;
  try {
    decideCalibration(
      { bodyDurationMs: 100, label: "healthy" },
      {
        label: "calibration-direct-signal-too-small",
        reportError: null,
        targetCount: 1,
        directTimingError: null,
        directTiming: timingWithRates([0.25, 0.25, 0.2625, 0.25, 0.25]),
        receiptVitestVersion: pinnedVitestVersion,
        installedVitestVersion: pinnedVitestVersion,
        bodyDurationMs: 200,
      },
    );
  } catch (error) {
    inconclusiveDirectSignal =
      error?.outcome === "CALIBRATION_INCONCLUSIVE" &&
      error?.details?.reason === "the direct per-round lower bound did not dominate the predeclared per-round allowance";
    inconclusiveDirectDetails = error?.details;
  }
  if (!inconclusiveDirectSignal) throw new Error("G80 self-test did not reject an inconclusive direct signal");
  if (
    inconclusiveDirectDetails?.directTiming === null ||
    inconclusiveDirectDetails?.calibrationObservation?.directTiming === null ||
    inconclusiveDirectDetails?.healthyObservation === null ||
    inconclusiveDirectDetails?.representativeSelection !== "not-reached" ||
    JSON.stringify(inconclusiveDirectDetails?.attempts) !== "[]" ||
    inconclusiveDirectDetails?.semanticTimeout !== "not-reached" ||
    inconclusiveDirectDetails?.uncertainty?.allowanceMs === null
  ) {
    throw new Error("G80 self-test did not retain complete inconclusive calibration evidence");
  }
  let rangeExceeded = false;
  try {
    representativeRoundsFor(9_999, {
      directPerRoundMs: 0.0001,
      directRateLowerBoundMs: 0.0001,
    });
  } catch (error) {
    rangeExceeded = error?.outcome === "REPRESENTATIVE_RANGE_EXCEEDED";
  }
  if (!rangeExceeded) throw new Error("G80 self-test did not exercise REPRESENTATIVE_RANGE_EXCEEDED");
  let oracleFailure = false;
  try {
    requireHealthy({ processStatus: 1, bodyStatus: "failed", label: "self-test", output: "" });
  } catch (error) {
    oracleFailure = error?.outcome === "HEALTHY_OR_ORACLE_FAILURE";
  }
  if (!oracleFailure) throw new Error("G80 self-test did not exercise HEALTHY_OR_ORACLE_FAILURE");
  const structuredTimeout = runStructuredTimeoutReceiptSelfTest();
  const durableRecords = runDurableRecordSelfTest();
  process.stdout.write(JSON.stringify({
    budgetMs,
    calibrationRounds,
    g69OperationsPerRound,
    safetyFactor,
    directTimingPlan: {
      warmUpRounds: directTimingPlan.warmUpRounds,
      chunks: directTimingPlan.chunks,
      scoringRounds: directTimingPlan.scoringRounds,
    },
    equalSizeResidualBoundMs,
    structuredTimeout,
    durableRecords,
    selfTest: {
      directTiming: "vitest-body-clock-g69-path-and-separated-warm-up-valid",
      unitMismatchMutant: "red-by-avoiding-whole-test-vs-per-round-comparison",
      inconclusiveDirectSignal: "red",
      warmUpOmissionMutant: "red",
      mixedChunkPlanMutant: "red",
      equalSizeResidualMutant: "red",
      crossSizeGate: "removed-with-equal-size-only-plan",
    },
  }) + "\n");
}

function main() {
  const sourcePath = resolve(root, testFile);
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  let healthy = null;
  let calibration = null;
  let estimate = "not-reached";
  let representativeSelection = "not-reached";
  let semanticTimeout = "not-reached";
  const stages = [];
  const attempts = [];
  try {
    if (process.argv.includes("--observation-only")) {
      return observationOnly(sourcePath, original);
    }
    healthy = runOracle("G67 AC3 healthy", { retainReport: true });
    const healthyStage = emitStage(stages, "healthy", healthy, { status: "observed" });
    requireHealthy(healthy);
    if (healthy.bodyDurationMs >= budgetMs) {
      throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
        reason: "healthy G67 body already consumes its budget",
        healthyBodyMs: healthy.bodyDurationMs,
        budgetMs,
      });
    }

    const directMutationRounds = directMutationRoundsTotal();
    writeFileSync(
      sourcePath,
      mutate(original, directMutationRounds, { directTiming: true }),
      "utf8",
    );
    calibration = runOracle(
      "G67 AC3 " + directMutationRounds + "-round G69 direct calibration",
      { retainReport: true },
    );
    const calibrationStage = emitStage(stages, "calibration", calibration, { status: "observed" });
    requireHealthy(calibration);
    const calibrationDecision = decideCalibration(healthy, calibration);
    try {
      estimate = representativeRoundsFor(
        healthy.bodyDurationMs,
        calibrationDecision,
      );
      representativeSelection = {
        status: "selected",
        rounds: estimate.representativeRounds,
        healthyMarginMs: estimate.healthyMarginMs,
        source: "conservative direct per-round lower bound",
      };
      emitStage(stages, "estimate", null, {
        status: "selected",
        estimate,
        representativeSelection,
      });
    } catch (error) {
      emitStage(stages, "estimate", null, {
        status: "failed",
        error: {
          outcome: error?.outcome ?? null,
          message: String(error?.message ?? error),
          details: error?.details ?? null,
        },
        representativeSelection,
      });
      throw error;
    }

    let representativeRounds = estimate.representativeRounds;
    let regression;
    while (representativeRounds <= maxRepresentativeRounds) {
      writeFileSync(
        sourcePath,
        mutate(original, representativeRounds, { directTiming: false }),
        "utf8",
      );
      regression = runOracle(
        "G67 AC3 " + representativeRounds + "-round G69 representative",
        { retainReport: true },
      );
      const attemptStage = emitStage(stages, "representative-attempt", regression, {
        status: "observed",
        attemptIndex: attempts.length,
        rounds: representativeRounds,
      });
      attempts.push({
        rounds: representativeRounds,
        stageId: attemptStage.stageId,
        canonicalDigest: attemptStage.canonicalDigest,
      });
      const classification = classifyRepresentativeResult(regression);
      if (classification.kind === "semantic-timeout") {
        semanticTimeout = {
          status: "exact-named-target-timeout",
          rounds: representativeRounds,
          stageId: attemptStage.stageId,
          canonicalDigest: attemptStage.canonicalDigest,
          expected: "Test timed out in 10000ms.",
          received: regression.receiptTarget?.errors?.[0]?.message?.split("\n", 1)[0] ?? null,
        };
        break;
      }
      const nextRounds = Math.ceil(representativeRounds * safetyFactor);
      if (nextRounds <= representativeRounds) break;
      representativeRounds = nextRounds;
    }
    if (regression === undefined || semanticTimeout === "not-reached") {
      throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
        reason: "G67 representative did not produce an exact named-target timeout before the bounded range ended",
      });
    }
    const summary = createDurableSummary(stages, {
      testName,
      originalRunnerSha256,
      outcome: "healthy-green-g69-path-timeout-red",
      disposition: "exact-named-target-timeout",
      budgetMs,
      calibrationRounds,
      healthyBodyMs: healthy.bodyDurationMs,
      healthyMarginMs: estimate.healthyMarginMs,
      calibrationBodyMs: calibration.bodyDurationMs,
      signedDifferenceMs: calibrationDecision.signedDifferenceMs,
      wholeTestAttribution: {
        signedDifferenceMs: calibrationDecision.signedDifferenceMs,
        ratio: calibrationDecision.wholeTestAttributionRatio,
        unit: "whole-test-ms-attribution-only",
      },
      directTiming: calibrationDecision.timing,
      allowance: calibrationDecision.allowance,
      uncertainty: {
        observedRateSpread: calibrationDecision.allowance.observedRateSpread,
        equalSizeResidualBoundMs: calibrationDecision.allowance.equalSizeResidualBoundMs,
        warmUpRounds: calibrationDecision.timing.warmUpRounds,
        warmUpDurationMs: calibrationDecision.timing.warmUpDurationMs,
      },
      directPerRoundMs: calibrationDecision.directPerRoundMs,
      directRateLowerBoundMs: calibrationDecision.directRateLowerBoundMs,
      directRateMedianMs: calibrationDecision.directRateMedianMs,
      predictedAddedWorkMs: calibrationDecision.predictedAddedWorkMs,
      directSignalDominatesAllowance: calibrationDecision.directSignalDominatesAllowance,
      scalingRatio: calibrationDecision.scalingRatio,
      decisionPath: calibrationDecision.decisionPath,
      representativeRounds,
      regressionBodyMs: regression.bodyDurationMs,
      regressionOverBudgetMs: regression.bodyDurationMs - budgetMs,
      processOverheadMs: {
        healthy: healthy.processElapsedMs - healthy.bodyDurationMs,
        calibration: calibration.processElapsedMs - calibration.bodyDurationMs,
        regression: regression.processElapsedMs - regression.bodyDurationMs,
      },
      representativeSelection,
      attempts,
      semanticTimeout,
      healthyStageId: healthyStage.stageId,
      calibrationStageId: calibrationStage.stageId,
    });
    process.stdout.write(durableRecordLine(durableSummaryPrefix, summary) + "\n");
  } catch (error) {
    const outcome = error?.outcome ?? "HEALTHY_OR_ORACLE_FAILURE";
    const details = {
      ...compactFailureDetails(error?.details),
      healthyObservation: error?.details?.healthyObservation ?? oracleEvidence(healthy),
      calibrationObservation: error?.details?.calibrationObservation ?? oracleEvidence(calibration),
      directTiming: error?.details?.directTiming ?? calibration?.directTiming ?? null,
      directTimingError: error?.details?.directTimingError ?? calibration?.directTimingError ?? null,
      uncertainty: error?.details?.uncertainty ?? null,
      estimate,
      representativeSelection,
      attempts,
      semanticTimeout,
    };
    const failure = { ...details };
    delete failure.directTiming;
    delete failure.directTimingError;
    delete failure.timing;
    delete failure.uncertainty;
    delete failure.healthyObservation;
    delete failure.calibrationObservation;
    delete failure.representativeSelection;
    delete failure.attempts;
    delete failure.semanticTimeout;
    const summary = createDurableSummary(stages, {
      outcome,
      disposition: "fail-closed",
      budgetMs,
      testName,
      originalRunnerSha256,
      failure,
      directTiming: details.directTiming,
      directTimingError: details.directTimingError,
      uncertainty: details.uncertainty,
      representativeSelection,
      attempts,
      semanticTimeout,
      healthyStageId: stages.find((stage) => stage.stage === "healthy")?.stageId ?? null,
      calibrationStageId: stages.find((stage) => stage.stage === "calibration")?.stageId ?? null,
    });
    process.stderr.write(durableRecordLine(durableSummaryPrefix, summary) + "\n");
    process.stderr.write("G80_CALIBRATION_FAILURE " + JSON.stringify({
      outcome,
      canonicalDigest: summary.canonicalDigest,
      reconstructionDigest: summary.reconstructionDigest,
    }) + "\n");
    process.exitCode = 1;
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

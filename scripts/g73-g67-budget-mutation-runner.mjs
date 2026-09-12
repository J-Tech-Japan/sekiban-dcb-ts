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
// These bounds are declared before any measurement is collected.  The direct
// signal must be stable across the intentionally different chunk sizes, while
// the repeated-size pair supplies the same-unit residual allowance.
const crossSizeRateLowerBoundRatio = 0.5;
const crossSizeRateUpperBoundRatio = 2;
const equalSizeResidualBoundMs = 10;
const directTimingPlan = Object.freeze({
  chunks: [4, 8, 12, 4, 4],
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
  return {
    sourceSha: process.env.GITHUB_SHA ?? gitIdentity(),
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

function chunkPlanFor(rounds) {
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
  const chunkPlan = directTiming ? chunkPlanFor(rounds) : [rounds];
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
        "          if (g73RoundOffset !== g73G69ExtraRounds) {",
        '            throw new Error("G80 direct timing did not account for every calibration round");',
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
        "            chunks: g73TimingChunks,",
        "            totalRounds: g73RoundOffset,",
        "            operationsPerRound: g73G69OperationsPerRound,",
        "            deliveryCount: g73RoundOffset * g73G69OperationsPerRound,",
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
    "          let g73RoundOffset = 0;",
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
      receiptTarget,
      receiptFinalStatus: receipt?.finalStatus ?? null,
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
    result.receiptTargetCount === 1 &&
    Array.isArray(result.collectionErrors) && result.collectionErrors.length === 0 &&
    Array.isArray(result.unhandledErrors) && result.unhandledErrors.length === 0
  ) return;
  throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
    label: result.label,
    processStatus: result.processStatus,
    signal: result.signal,
    bodyStatus: result.bodyStatus,
    targetCount: result.targetCount,
    receiptTargetCount: result.receiptTargetCount,
    receiptTarget: result.receiptTarget,
    receiptFinalStatus: result.receiptFinalStatus,
    collectionErrors: result.collectionErrors,
    unhandledErrors: result.unhandledErrors,
    spawnError: result.spawnError,
    reportError: result.reportError,
    receiptError: result.receiptError,
    directTimingError: result.directTimingError,
    output: result.output,
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
    Array.isArray(result.collectionErrors) && result.collectionErrors.length === 0 &&
    Array.isArray(result.unhandledErrors) && result.unhandledErrors.length === 0;
  if (isExactTargetTimeout) return;
  throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
    label: result.label,
    reason: "representative did not produce exactly one named target timeout",
    processStatus: result.processStatus,
    signal: result.signal,
    bodyStatus: result.bodyStatus,
    bodyDurationMs: result.bodyDurationMs,
    targetCount: result.targetCount,
    receiptTargetCount: result.receiptTargetCount,
    receiptTarget: result.receiptTarget,
    receiptTests: result.receiptTests,
    receiptFinalStatus: result.receiptFinalStatus,
    collectionErrors: result.collectionErrors,
    unhandledErrors: result.unhandledErrors,
    spawnError: result.spawnError,
    reportError: result.reportError,
    receiptError: result.receiptError,
    failureMessages: result.failureMessages,
    output: result.output,
  });
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
  if (!Array.isArray(timing.chunks) || timing.chunks.length < 2) {
    fail("at least two direct timing batches are required");
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
  if (new Set(timing.chunks.map((chunk) => chunk.rounds)).size < 2) {
    fail("the direct timing batches do not test scaling");
  }
  return timing;
}

function deriveAllowance(timing) {
  const costs = timing.chunks.map((chunk) => chunk.durationMs / chunk.rounds);
  const referenceRateMs = median(costs);
  const crossSizeRateBounds = {
    referenceRateMs,
    lowerRatio: crossSizeRateLowerBoundRatio,
    upperRatio: crossSizeRateUpperBoundRatio,
    lowerMs: referenceRateMs * crossSizeRateLowerBoundRatio,
    upperMs: referenceRateMs * crossSizeRateUpperBoundRatio,
    observedMinMs: Math.min(...costs),
    observedMaxMs: Math.max(...costs),
  };
  const crossSizeViolations = costs.flatMap((costMs, index) =>
    costMs < crossSizeRateBounds.lowerMs || costMs > crossSizeRateBounds.upperMs
      ? [{ index, costMs }]
      : [],
  );
  if (crossSizeViolations.length > 0) {
    throw outcomeError("CALIBRATION_INCONCLUSIVE", {
      reason: "a direct per-round rate escaped the predeclared two-sided cross-size bounds",
      crossSizeRateBounds,
      crossSizeViolations,
      costsPerRoundMs: costs,
    });
  }
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
    crossSizeRateBounds,
    directRateLowerBoundMs: Math.min(...costs),
    directRateMedianMs: referenceRateMs,
  };
}

function decideCalibration(healthy, calibration) {
  if (
    calibration.reportError !== null ||
    calibration.targetCount !== 1 ||
    calibration.directTimingError !== null ||
    calibration.directTiming === null
  ) {
    throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
      label: calibration.label,
      reason: "calibration report or direct timing marker was missing/malformed",
      processStatus: calibration.processStatus,
      signal: calibration.signal,
      bodyStatus: calibration.bodyStatus,
      targetCount: calibration.targetCount,
      reportError: calibration.reportError,
      directTimingError: calibration.directTimingError,
      output: calibration.output,
    });
  }
  const timing = validateDirectTiming(calibration.directTiming);
  const signedDifferenceMs = calibration.bodyDurationMs - healthy.bodyDurationMs;
  let allowance;
  try {
    allowance = deriveAllowance(timing);
  } catch (error) {
    if (error?.outcome === "CALIBRATION_INCONCLUSIVE") {
      error.details = {
        ...error.details,
        healthyBodyMs: healthy.bodyDurationMs,
        calibrationBodyMs: calibration.bodyDurationMs,
        signedDifferenceMs,
      };
    }
    throw error;
  }
  const directRateLowerBoundMs = allowance.directRateLowerBoundMs;
  const directRateMedianMs = allowance.directRateMedianMs;
  const scalingRatio = allowance.crossSizeRateBounds.observedMaxMs /
    allowance.crossSizeRateBounds.observedMinMs;
  // Representative sizing and the acceptance gate use only the direct
  // per-round lower bound.  Whole-test timing is retained below as an
  // attribution diagnostic and is deliberately never compared with the
  // per-round allowance.
  const predictedAddedWorkMs = directRateLowerBoundMs * calibrationRounds;
  const wholeTestAttributionRatio = Number.isFinite(signedDifferenceMs) && predictedAddedWorkMs > 0
    ? signedDifferenceMs / predictedAddedWorkMs
    : null;
  if (!Number.isFinite(directRateLowerBoundMs) || directRateLowerBoundMs <= allowance.allowanceMs) {
    throw outcomeError("CALIBRATION_INCONCLUSIVE", {
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
    });
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
      crossSizeRateBounds: "passed",
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
    healthy,
    calibration,
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
  process.stdout.write(JSON.stringify({
    phase: "G80_AC1_OBSERVATION_INPUT",
    metadata: receiptMetadata(),
    record,
  }) + "\n");
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
    emitObservation(record);
  }
  const summary = {
    phase: "G80_AC1_OBSERVATION_SUMMARY",
    metadata: receiptMetadata(),
    predeclaredPairs: requestedPairs,
    requiredFreshHostedJobInstances: true,
    originalRunnerSha256,
    records,
    missingOrFailedPairs: records.filter((record) =>
      record.healthy.processStatus !== 0 ||
      record.healthy.bodyStatus !== "passed" ||
      record.calibration.processStatus !== 0 ||
      record.calibration.bodyStatus !== "passed"
    ).map((record) => record.pairIndex),
    note: "A local invocation cannot claim fresh hosted job separation; hosted receipts remain required evidence.",
  };
  writeFileSync(
    resolve(observationRoot, "summary-" + process.pid + ".json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  process.stdout.write(JSON.stringify(summary) + "\n");
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
    target: target[0],
    receiptFinalStatus: receipt.finalStatus,
  };
}

function selfTest() {
  const source = readFileSync(resolve(root, testFile), "utf8");
  const mutated = mutate(source, calibrationRounds);
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
    chunks: [
      { rounds: 8, operations: 16, deliveryCount: 16, durationMs: 80, waitersDrained: true },
      { rounds: 16, operations: 32, deliveryCount: 32, durationMs: 160, waitersDrained: true },
      { rounds: 8, operations: 16, deliveryCount: 16, durationMs: 88, waitersDrained: true },
    ],
    totalRounds: 32,
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
  validateDirectTiming(validTiming);
  const validAllowance = deriveAllowance(validTiming);
  if (
    validAllowance.directRateLowerBoundMs !== 10 ||
    validAllowance.directRateMedianMs !== 10 ||
    validAllowance.allowanceMs !== 1 ||
    validAllowance.crossSizeRateBounds.lowerMs !== 5 ||
    validAllowance.crossSizeRateBounds.upperMs !== 20 ||
    validAllowance.equalSizeResidualBoundMs !== equalSizeResidualBoundMs
  ) {
    throw new Error("G80 self-test did not retain the predeclared direct-rate/residual bounds");
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
      throw new Error("G80 self-test rejected " + name + " for the wrong reason: " + String(error));
    }
    throw new Error("G80 self-test accepted " + name);
  };
  expectAllowanceRejection(
    "low cross-size rate mutant",
    timingWithRates([4, 10, 11]),
    "a direct per-round rate escaped the predeclared two-sided cross-size bounds",
  );
  expectAllowanceRejection(
    "high cross-size rate mutant",
    timingWithRates([10, 25, 11]),
    "a direct per-round rate escaped the predeclared two-sided cross-size bounds",
  );
  expectAllowanceRejection(
    "equal-size residual mutant",
    timingWithRates([8, 10, 19]),
    "the equal-size residual escaped the predeclared same-unit bound",
  );
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
    receiptTarget: {
      state: "failed",
      errors: [{ name: "Error", message: "Test timed out in 10000ms.", stack: "Error: Test timed out in 10000ms." }],
    },
    receiptTests: [{ state: "failed", errors: [{ message: "Test timed out in 10000ms." }] }],
    collectionErrors: [],
    unhandledErrors: [],
    failureMessages: ["Test timed out in 10000ms."],
    output: "",
  };
  requireTimeoutRegression(validTimeoutReceipt);
  for (const [name, rejectedReceipt] of [
    ["signal termination", { ...validTimeoutReceipt, signal: "SIGTERM" }],
    ["missing target", { ...validTimeoutReceipt, targetCount: 0, receiptTargetCount: 0, receiptTarget: undefined }],
    ["setup/import failure", { ...validTimeoutReceipt, collectionErrors: [{ message: "Failed to load setup file" }] }],
    ["unhandled error", { ...validTimeoutReceipt, unhandledErrors: [{ message: "unhandled" }] }],
    ["green target", { ...validTimeoutReceipt, bodyStatus: "passed", receiptFinalStatus: "passed", receiptTarget: { state: "passed", errors: [] }, receiptTests: [{ state: "passed", errors: [] }] }],
    ["wrong timeout message", { ...validTimeoutReceipt, failureMessages: ["Test timed out in 5000ms."], receiptTarget: { state: "failed", errors: [{ message: "Test timed out in 5000ms." }] } }],
    ["incomplete process", { ...validTimeoutReceipt, processStatus: null }],
    ["spawn error", { ...validTimeoutReceipt, spawnError: "spawn failed" }],
    ["unrelated failed test", { ...validTimeoutReceipt, receiptTests: [{ state: "failed", errors: [{ message: "Test timed out in 10000ms." }] }, { state: "failed", errors: [{ message: "AssertionError: unrelated" }] }] }],
  ]) {
    let rejected = false;
    try {
      requireTimeoutRegression(rejectedReceipt);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("G80 self-test accepted an invalid timeout receipt: " + name);
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
  try {
    decideCalibration(
      { bodyDurationMs: 100, label: "healthy" },
      {
        label: "calibration-direct-signal-too-small",
        reportError: null,
        targetCount: 1,
        directTimingError: null,
        directTiming: timingWithRates([0.25, 0.25, 0.2625]),
        bodyDurationMs: 200,
      },
    );
  } catch (error) {
    inconclusiveDirectSignal =
      error?.outcome === "CALIBRATION_INCONCLUSIVE" &&
      error?.details?.reason === "the direct per-round lower bound did not dominate the predeclared per-round allowance";
  }
  if (!inconclusiveDirectSignal) throw new Error("G80 self-test did not reject an inconclusive direct signal");
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
  process.stdout.write(JSON.stringify({
    budgetMs,
    calibrationRounds,
    g69OperationsPerRound,
    safetyFactor,
    crossSizeRateLowerBoundRatio,
    crossSizeRateUpperBoundRatio,
    equalSizeResidualBoundMs,
    structuredTimeout,
    selfTest: {
      directTiming: "vitest-body-clock-and-g69-path-valid",
      unitMismatchMutant: "red-by-avoiding-whole-test-vs-per-round-comparison",
      inconclusiveDirectSignal: "red",
      crossSizeRateLowerBoundMutant: "red",
      crossSizeRateUpperBoundMutant: "red",
      equalSizeResidualMutant: "red",
    },
  }) + "\n");
}

function main() {
  const sourcePath = resolve(root, testFile);
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    if (process.argv.includes("--observation-only")) {
      return observationOnly(sourcePath, original);
    }
    const healthy = runOracle("G67 AC3 healthy", { retainReport: true });
    requireHealthy(healthy);
    if (healthy.bodyDurationMs >= budgetMs) {
      throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
        reason: "healthy G67 body already consumes its budget",
        healthyBodyMs: healthy.bodyDurationMs,
        budgetMs,
      });
    }

    writeFileSync(
      sourcePath,
      mutate(original, calibrationRounds, { directTiming: true }),
      "utf8",
    );
    const calibration = runOracle(
      "G67 AC3 " + calibrationRounds + "-round G69 direct calibration",
      { retainReport: true },
    );
    requireHealthy(calibration);
    const calibrationDecision = decideCalibration(healthy, calibration);
    const estimate = representativeRoundsFor(
      healthy.bodyDurationMs,
      calibrationDecision,
    );

    const attempts = [];
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
      attempts.push({
        rounds: representativeRounds,
        processStatus: regression.processStatus,
        signal: regression.signal,
        bodyStatus: regression.bodyStatus,
        bodyDurationMs: regression.bodyDurationMs,
        processElapsedMs: regression.processElapsedMs,
        targetCount: regression.targetCount,
        failureMessages: regression.failureMessages,
      });
      if (regression.processStatus !== 0 && regression.bodyStatus === "failed") {
        break;
      }
      const nextRounds = Math.ceil(representativeRounds * safetyFactor);
      if (nextRounds <= representativeRounds) break;
      representativeRounds = nextRounds;
    }
    if (regression === undefined) {
      throw outcomeError("HEALTHY_OR_ORACLE_FAILURE", {
        reason: "G67 representative did not run",
      });
    }
    requireTimeoutRegression(regression);
    process.stdout.write(JSON.stringify({
      budgetMs,
      testName,
      originalRunnerSha256,
      healthyBodyMs: healthy.bodyDurationMs,
      healthyMarginMs: estimate.healthyMarginMs,
      calibrationRounds,
      calibrationBodyMs: calibration.bodyDurationMs,
      signedDifferenceMs: calibrationDecision.signedDifferenceMs,
      directPerRoundMs: calibrationDecision.directPerRoundMs,
      directRateLowerBoundMs: calibrationDecision.directRateLowerBoundMs,
      directRateMedianMs: calibrationDecision.directRateMedianMs,
      predictedAddedWorkMs: calibrationDecision.predictedAddedWorkMs,
      wholeTestAttributionRatio: calibrationDecision.wholeTestAttributionRatio,
      directSignalDominatesAllowance: calibrationDecision.directSignalDominatesAllowance,
      predictionRatio: calibrationDecision.predictionRatio,
      scalingRatio: calibrationDecision.scalingRatio,
      crossSizeRateBounds: calibrationDecision.allowance.crossSizeRateBounds,
      equalSizeResidualBoundMs: calibrationDecision.allowance.equalSizeResidualBoundMs,
      decisionPath: calibrationDecision.decisionPath,
      allowance: calibrationDecision.allowance,
      directTiming: calibrationDecision.timing,
      representativeRounds,
      regressionBodyMs: regression.bodyDurationMs,
      regressionOverBudgetMs: regression.bodyDurationMs - budgetMs,
      timeoutMessage: "Test timed out in 10000ms",
      processOverheadMs: {
        healthy: healthy.processElapsedMs - healthy.bodyDurationMs,
        calibration: calibration.processElapsedMs - calibration.bodyDurationMs,
        regression: regression.processElapsedMs - regression.bodyDurationMs,
      },
      attempts,
      result: "healthy-green-g69-path-timeout-red",
    }) + "\n");
  } catch (error) {
    const outcome = error?.outcome ?? "HEALTHY_OR_ORACLE_FAILURE";
    process.stderr.write(JSON.stringify({
      result: "failed",
      outcome,
      details: error?.details ?? null,
      message: String(error?.message ?? error),
    }) + "\n");
    process.exitCode = 1;
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

function g69AddedWorkBlock(rounds) {
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

function mutate(source, rounds) {
  const occurrences = source.split(mutationAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G67 AC3 G69-work mutation anchor expected once, found ${occurrences}`);
  }
  return source.replace(mutationAnchor, g69AddedWorkBlock(rounds) + mutationAnchor);
}

function targetResult(report) {
  const results = report.testResults?.flatMap((file) => file.assertionResults ?? []) ?? [];
  const target = results.find((result) => result.fullName?.endsWith(testName));
  if (target === undefined) {
    throw new Error(`G67 AC3 result was not present in Vitest JSON report: ${JSON.stringify(report)}`);
  }
  if (typeof target.duration !== "number") {
    throw new Error(`G67 AC3 result had no test-body duration: ${JSON.stringify(target)}`);
  }
  return target;
}

function runOracle(label) {
  const reportDirectory = mkdtempSync(resolve(tmpdir(), "sdt-g73-g67-"));
  const reportPath = resolve(reportDirectory, "vitest.json");
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [
    vitest, "run", "--config", "vitest.config.ts", "--no-cache",
    "--maxWorkers=1", testFile, "--testNamePattern", testName,
    "--reporter=json", "--reporter=verbose", "--outputFile", reportPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const processElapsedMs = Math.round(performance.now() - startedAt);
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const test = targetResult(report);
    return {
      label,
      processStatus: result.status ?? 1,
      processElapsedMs,
      bodyStatus: test.status,
      bodyDurationMs: test.duration,
      failureMessages: test.failureMessages ?? [],
      output: (result.stdout ?? "") + (result.stderr ?? ""),
    };
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function requireHealthy(result) {
  if (result.processStatus === 0 && result.bodyStatus === "passed") return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireTimeoutRegression(result) {
  const timeoutMessage = /(?:Test )?timed out in\s+10(?:,|_)?000ms/i;
  const outputHasTimeout = timeoutMessage.test(result.output);
  if (result.processStatus !== 0 && result.bodyStatus === "failed" &&
      result.bodyDurationMs >= budgetMs && outputHasTimeout) return;
  throw new Error(`G67 AC3 G69-added-work representative did not hit the intended test-body timeout:\n${JSON.stringify({
    processStatus: result.processStatus,
    bodyStatus: result.bodyStatus,
    bodyDurationMs: result.bodyDurationMs,
    failureMessages: result.failureMessages,
    output: result.output,
  })}`);
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
  process.stdout.write(JSON.stringify({
    budgetMs,
    calibrationRounds,
    g69OperationsPerRound,
    safetyFactor,
    selfTest: "vitest-body-clock-and-g69-path-valid",
  }) + "\n");
}

function main() {
  const sourcePath = resolve(root, testFile);
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    const healthy = runOracle("G67 AC3 healthy");
    requireHealthy(healthy);
    if (healthy.bodyDurationMs >= budgetMs) {
      throw new Error(`G67 AC3 healthy body already consumes the ${budgetMs}ms budget: ${healthy.bodyDurationMs}ms`);
    }

    writeFileSync(sourcePath, mutate(original, calibrationRounds), "utf8");
    const calibration = runOracle(`G67 AC3 ${calibrationRounds}-round G69 calibration`);
    requireHealthy(calibration);
    const measuredAddedWorkPerRoundMs = Math.max(
      1,
      (calibration.bodyDurationMs - healthy.bodyDurationMs) / calibrationRounds,
    );
    const healthyMarginMs = budgetMs - healthy.bodyDurationMs;
    let representativeRounds = Math.max(
      calibrationRounds + 1,
      Math.ceil((healthyMarginMs / measuredAddedWorkPerRoundMs) * safetyFactor),
    );
    if (representativeRounds > maxRepresentativeRounds) {
      throw new Error(`G67 representative exceeds bounded calibration range: ${representativeRounds} rounds`);
    }

    const attempts = [];
    let regression;
    while (representativeRounds <= maxRepresentativeRounds) {
      writeFileSync(sourcePath, mutate(original, representativeRounds), "utf8");
      regression = runOracle(`G67 AC3 ${representativeRounds}-round G69 representative`);
      attempts.push({
        rounds: representativeRounds,
        processStatus: regression.processStatus,
        bodyStatus: regression.bodyStatus,
        bodyDurationMs: regression.bodyDurationMs,
        processElapsedMs: regression.processElapsedMs,
      });
      if (regression.processStatus !== 0 && regression.bodyStatus === "failed") break;
      representativeRounds = Math.ceil(representativeRounds * safetyFactor);
    }
    if (regression === undefined) throw new Error("G67 representative did not run");
    requireTimeoutRegression(regression);
    process.stdout.write(JSON.stringify({
      budgetMs,
      testName,
      healthyBodyMs: healthy.bodyDurationMs,
      healthyMarginMs,
      calibrationRounds,
      calibrationBodyMs: calibration.bodyDurationMs,
      measuredAddedWorkPerRoundMs: Number(measuredAddedWorkPerRoundMs.toFixed(2)),
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
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

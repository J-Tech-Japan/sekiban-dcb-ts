#!/usr/bin/env node
/**
 * Structured receipt reporter for the G80 runner's own Vitest invocation.
 *
 * This is intentionally separate from the hosted G79 timing reporter.  G80
 * needs the complete target result, including TestCase.result().errors, and
 * the distinction between a target assertion timeout and a run/setup or
 * collection failure.  The runner supplies a unique output path for every
 * invocation so a stale receipt cannot be reused.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const receiptPath = process.env.SDT_G80_RECEIPT_PATH;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function errorRecord(error) {
  if (error == null) return null;
  if (typeof error === "string") return { name: null, message: error, stack: null };
  return {
    name: text(error.name),
    message: text(error.message) ?? text(error.toString),
    stack: text(error.stack),
    code: text(error.code),
  };
}

function versionAt(root) {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, "node_modules/vitest/package.json"), "utf8"));
    return text(packageJson.version);
  } catch {
    return null;
  }
}

function configuredTimeout(test) {
  const runtimeOption = test?.options?.timeout;
  if (Number.isFinite(runtimeOption)) return runtimeOption;
  const environmentValue = Number(process.env.SDT_G80_TEST_TIMEOUT_MS ?? "");
  return Number.isFinite(environmentValue) ? environmentValue : null;
}

function moduleName(root, module) {
  const absolute = module?.moduleId ?? module?.relativeModuleId ?? null;
  if (typeof absolute !== "string") return null;
  return absolute.startsWith("/") ? relative(root, absolute) : absolute;
}

function testRecord(root, test) {
  const result = typeof test?.result === "function" ? test.result() : null;
  const diagnostic = typeof test?.diagnostic === "function" ? test.diagnostic() : null;
  const options = test?.options ?? {};
  const errors = Array.isArray(result?.errors)
    ? result.errors.map(errorRecord).filter(Boolean)
    : [];
  return {
    id: text(test?.id),
    module: moduleName(root, test?.module),
    fullName: text(test?.fullName) ?? text(test?.name),
    title: text(test?.name),
    state: text(result?.state) ?? "pending",
    durationMs: finiteNumber(diagnostic?.duration),
    configuredTimeoutMs: configuredTimeout(test),
    retryCount: finiteNumber(diagnostic?.retryCount),
    repeatCount: finiteNumber(diagnostic?.repeatCount),
    flaky: diagnostic?.flaky === true,
    retry: options.retry ?? null,
    repeats: options.repeats ?? null,
    errors,
  };
}

function moduleErrors(module) {
  if (typeof module?.errors !== "function") return [];
  try {
    return module.errors().map(errorRecord).filter(Boolean);
  } catch (error) {
    return [{ name: "ReporterError", message: String(error), stack: null }];
  }
}

export default class G80VitestReceiptReporter {
  constructor() {
    this.path = receiptPath;
    this.root = process.cwd();
    this.vitestVersion = null;
    this.tests = new Map();
    this.startedAt = Date.now();
  }

  onInit(vitest) {
    if (this.path === undefined) return;
    this.root = vitest?.config?.root ?? process.cwd();
    this.vitestVersion = versionAt(this.root);
  }

  onTestCaseResult(test) {
    if (this.path === undefined) return;
    const row = testRecord(this.root, test);
    this.tests.set(row.id ?? `${row.module}:${row.fullName}`, row);
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (this.path === undefined) return;
    for (const module of testModules ?? []) {
      let allTests = [];
      try {
        allTests = [...module.children.allTests()];
      } catch {
        allTests = [];
      }
      for (const test of allTests) {
        const key = test.id ?? `${moduleName(this.root, module)}:${test.fullName}`;
        if (!this.tests.has(key)) this.tests.set(key, testRecord(this.root, test));
      }
    }
    const tests = [...this.tests.values()];
    const failedTests = tests.filter((test) => test.state === "failed");
    const failedAssertions = failedTests.flatMap((test) => test.errors);
    const collectionErrors = (testModules ?? []).flatMap(moduleErrors);
    const unhandled = (unhandledErrors ?? []).map(errorRecord).filter(Boolean);
    const receipt = {
      schema: "sdt-g80-vitest-receipt-v1",
      source: "g80-vitest-receipt-reporter",
      vitestVersion: this.vitestVersion,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - this.startedAt,
      reason: text(reason),
      finalStatus: reason === "passed" && failedTests.length === 0 && collectionErrors.length === 0 && unhandled.length === 0
        ? "passed"
        : "failed",
      process: {
        pid: process.pid,
        node: process.version,
        platform: process.platform,
      },
      tests,
      counts: {
        total: tests.length,
        failed: failedTests.length,
        passed: tests.filter((test) => test.state === "passed").length,
        skipped: tests.filter((test) => test.state === "skipped").length,
        pending: tests.filter((test) => test.state === "pending").length,
      },
      failedAssertions,
      collectionErrors,
      unhandledErrors: unhandled,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(receipt, null, 2), "utf8");
    process.stdout.write(`SDT_G80_VITEST_RECEIPT ${JSON.stringify({ path: this.path, finalStatus: receipt.finalStatus })}\n`);
  }
}

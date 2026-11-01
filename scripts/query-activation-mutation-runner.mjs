#!/usr/bin/env node
/**
 * Prove executable query activation by mutation. Each mutation restores the
 * original source before the next one, and its named oracle must fail with
 * one assertion receipt.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("query activation mutation runner: Vitest executable is unavailable");

const worker = "packages/dcb-runtime/src/http/SerializedQueryWorker.ts";
const executor = "packages/dcb-runtime/src/query/PortableQueryExecutor.ts";

const mutations = Object.freeze([
  {
    id: "executable-registry-check-disabled",
    sourceFile: worker,
    from: "if (isExecutableQueryDefinition(definition)) {",
    to: "if (false && isExecutableQueryDefinition(definition)) {",
    oracle: "executable definitions do not fall back to the legacy parameter guard",
    reason: "an executable definition must not take the legacy parameter guard",
  },
  {
    id: "list-control-retained",
    sourceFile: worker,
    from: "const executableListControls = new Set([\"PageNumber\", \"PageSize\", \"NewestFirst\", \"consistency\"]);",
    to: "const executableListControls = new Set([\"PageSize\", \"NewestFirst\", \"consistency\"]);",
    oracle: "list controls are removed before domain params are decoded",
    reason: "PageNumber must be removed before the params codec runs",
  },
  {
    id: "projector-check-after-controls",
    sourceFile: worker,
    from: "  if (executableProjectorUnavailable(definition, options)) {\n    return error(503, \"projection_unavailable\", \"The mapped query projection is unavailable\");\n  }\n  const executablePagination = endpoint === \"list-query\" ? paginationFrom(parsed.queryParams) : { value: undefined };\n  if (executablePagination.value === undefined && executablePagination.error !== undefined) {\n    return error(400, \"validation_error\", executablePagination.error);\n  }",
    to: "  const executablePagination = endpoint === \"list-query\" ? paginationFrom(parsed.queryParams) : { value: undefined };\n  if (executablePagination.value === undefined && executablePagination.error !== undefined) {\n    return error(400, \"validation_error\", executablePagination.error);\n  }\n  if (executableProjectorUnavailable(definition, options)) {\n    return error(503, \"projection_unavailable\", \"The mapped query projection is unavailable\");\n  }",
    oracle: "disabled projector wins over invalid list consistency",
    reason: "a disabled projector must win over invalid list controls",
  },
  {
    id: "safe-scan-quarantine-probe-omitted",
    sourceFile: worker,
    from: "      if (outcome.kind === \"projection-unavailable\" && state.safeRead) {\n        const quarantined = await probeExecutableQuarantine(state, serviceId, viewId);\n        if (quarantined !== undefined) return quarantined;\n      }",
    to: "      if (false && outcome.kind === \"projection-unavailable\" && state.safeRead) {\n        const quarantined = await probeExecutableQuarantine(state, serviceId, viewId);\n        if (quarantined !== undefined) return quarantined;\n      }",
    oracle: "safe materialized scan rejection repeats the quarantine probe",
    reason: "a rejected safe materialized scan must repeat the quarantine probe",
  },
  {
    id: "materialized-scan-uses-legacy-page",
    sourceFile: worker,
    from: "const batch = await selection.store.scanRows(serviceId, viewId, {",
    to: "const batch = await selection.store.readListPage(serviceId, viewId, {",
    oracle: "executable materialized scans do not use the legacy page ports",
    reason: "an executable materialized scan must not use the legacy page port",
  },
  {
    id: "configured-scan-bound-ignored",
    sourceFile: worker,
    from: "const executableScanMaximum = options.maxScanRows ?? 1_000;",
    to: "const executableScanMaximum = 1_000;",
    oracle: "configured maxScanRows bounds the executable scan",
    reason: "the deployed maxScanRows value must bound the scan",
  },
  {
    id: "scan-omits-extra-row",
    sourceFile: executor,
    from: "batch = await input.scan(input.maximum + 1);",
    to: "batch = await input.scan(input.maximum);",
    oracle: "maximum plus one refuses before handlers",
    reason: "the scan must request one row past the configured maximum",
  },
  {
    id: "row-invalid-becomes-unavailable",
    sourceFile: worker,
    from: "return error(500, \"query_row_invalid\", \"The query projection contains an invalid row.\");",
    to: "return error(503, \"projection_unavailable\", \"The mapped query projection is unavailable\");",
    oracle: "corrupt rows stay query_row_invalid",
    reason: "a corrupt row must stay query_row_invalid",
  },
  {
    id: "handler-failed-becomes-result-invalid",
    sourceFile: worker,
    from: "return error(500, \"query_handler_failed\", \"The query handler failed.\");",
    to: "return error(500, \"query_result_invalid\", \"The query handler failed.\");",
    oracle: "thrown handlers stay query_handler_failed",
    reason: "a thrown handler must stay query_handler_failed",
  },
  {
    id: "handler-message-leaks-internal-text",
    sourceFile: worker,
    from: "\"The query handler failed.\"",
    to: "failure.message",
    oracle: "handler failures use the fixed safe message",
    reason: "the public handler failure must use the fixed safe message",
  },
  {
    id: "post-scan-admission-after-overflow",
    sourceFile: executor,
    from: "  if (input.afterScanAdmission !== undefined) await input.afterScanAdmission();\n  if (batch.candidates.length > input.maximum) return failure(\"scan-limit-exceeded\");",
    to: "  if (batch.candidates.length > input.maximum) return failure(\"scan-limit-exceeded\");\n  if (input.afterScanAdmission !== undefined) await input.afterScanAdmission();",
    oracle: "post-scan quarantine wins over overflow and corrupt rows",
    reason: "post-scan admission must run before overflow and row canonicalization",
  },
]);

let reports;

function fail(message) {
  throw new Error(`query activation mutation runner: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function reportPath(label) {
  reports ??= mkdtempSync(join(tmpdir(), "sdt-query-activation-"));
  return join(reports, `${label.replaceAll(/[^a-z0-9-]/gi, "_")}.json`);
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function processError(error) {
  return error === undefined ? undefined : {
    name: error.name,
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
  };
}

function runOracle(mutation) {
  const report = reportPath(mutation.id);
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    "test/query-activation.spec.ts",
    "--testNamePattern",
    mutation.oracle,
    "--reporter=json",
    "--outputFile",
    report,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: processError(result.error),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    structured: readReport(report),
  };
}

function assertions(result) {
  return (result.structured?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
}

function namedAssertions(result, mutation) {
  return assertions(result).filter((assertion) => assertion.title === mutation.oracle &&
    typeof assertion.fullName === "string" && assertion.fullName.endsWith(` ${mutation.oracle}`));
}

function requirePass(result, mutation) {
  assert(result.status === 0 && result.signal === null && result.error === undefined,
    `${mutation.id} control process was not clean: ${JSON.stringify({ status: result.status, signal: result.signal, error: result.error })}`);
  assert(result.structured?.success === true, `${mutation.id} control had no successful structured report`);
  const named = namedAssertions(result, mutation);
  assert(named.length === 1 && named[0].status === "passed", `${mutation.id} control did not pass its named oracle`);
}

function requireRed(result, mutation) {
  assert(result.status === 1, `${mutation.id} did not return semantic status 1`);
  assert(result.signal === null, `${mutation.id} terminated by signal ${result.signal}`);
  assert(result.error === undefined, `${mutation.id} failed to spawn: ${JSON.stringify(result.error)}`);
  assert(result.structured?.success === false, `${mutation.id} did not produce a failed structured report`);
  const all = assertions(result);
  const named = namedAssertions(result, mutation);
  assert(named.length === 1 && named[0].status === "failed", `${mutation.id} named oracle was missing, skipped, or ambiguous`);
  const failed = all.filter((assertion) => assertion.status === "failed");
  assert(failed.length === 1 && failed[0] === named[0], `${mutation.id} had an unrelated assertion failure`);
  const failures = (named[0].failureMessages ?? []).filter((message) => typeof message === "string");
  assert(failures.length > 0, `${mutation.id} had no assertion failure evidence`);
  const failureText = failures.join("\n");
  assert(!/(timed out|timeout|cannot find module|failed to load|setup|syntaxerror|referenceerror|sigterm|sigkill|killed|unhandled)/i.test(failureText),
    `${mutation.id} failure was infrastructure/setup/timeout evidence`);
  assert(/(assertionerror|expected|received|to (?:be|equal|have|contain|match))/i.test(failureText),
    `${mutation.id} failure was not an assertion receipt`);
  return {
    process: { status: result.status, signal: result.signal, error: result.error },
    namedOracle: named[0].fullName,
    failureMessages: failures,
  };
}

function mutate(source, mutation) {
  const occurrences = source.split(mutation.from).length - 1;
  assert(occurrences === 1, `${mutation.id} anchor count was ${occurrences}`);
  return source.replace(mutation.from, mutation.to);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(runOracle(mutation), mutation);
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    const red = runOracle(mutation);
    return { id: mutation.id, reason: mutation.reason, result: "behavioral-mutant-red", red: requireRed(red, mutation) };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

function syntheticResult(mutation, overrides = {}) {
  return {
    status: 1,
    signal: null,
    error: undefined,
    structured: {
      success: false,
      testResults: [{ assertionResults: [{
        title: mutation.oracle,
        fullName: `executable query activation ${mutation.oracle}`,
        status: "failed",
        failureMessages: ["AssertionError: expected safe value to equal raw value"],
      }] }],
    },
    ...overrides,
  };
}

function selfTest() {
  for (const mutation of mutations) {
    const source = readFileSync(resolve(root, mutation.sourceFile), "utf8");
    mutate(source, mutation);
  }
  const mutation = mutations[0];
  requireRed(syntheticResult(mutation), mutation);
  const rejected = [
    ["green escape", syntheticResult(mutation, { status: 0, structured: { success: true, testResults: [] } })],
    ["missing report", syntheticResult(mutation, { structured: undefined })],
    ["signal termination", syntheticResult(mutation, { status: null, signal: "SIGTERM" })],
    ["spawn error", syntheticResult(mutation, { status: null, error: { name: "Error", message: "spawn failed" } })],
    ["timeout", syntheticResult(mutation, { structured: { success: false, testResults: [{ assertionResults: [{ title: mutation.oracle, fullName: `SDT-G78 ${mutation.oracle}`, status: "failed", failureMessages: ["Test timed out in 5000ms"] }] }] } })],
    ["setup/import failure", syntheticResult(mutation, { structured: { success: false, testResults: [{ assertionResults: [{ title: "setup/import failure", fullName: "setup/import failure", status: "failed", failureMessages: ["Cannot find module"] }] }] } })],
    ["unrelated assertion", syntheticResult(mutation, { structured: { success: false, testResults: [{ assertionResults: [
      { title: mutation.oracle, fullName: `SDT-G78 ${mutation.oracle}`, status: "passed", failureMessages: [] },
      { title: "unrelated", fullName: "unrelated", status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] },
    ] }] } })],
  ];
  for (const [label, result] of rejected) {
    let accepted = false;
    try { requireRed(result, mutation); accepted = true; } catch { /* expected rejection */ }
    assert(!accepted, `validator accepted ${label}`);
  }
  return {
    mutations: mutations.map(({ id }) => id),
    selfTest: "anchors-and-structured-red-receipts",
    rejectedCases: rejected.map(([label]) => label),
  };
}

try {
  const synthetic = process.argv.includes("--self-test") ? selfTest() : undefined;
  const rows = mutations.map(runMutation);
  process.stdout.write(`${JSON.stringify({
    status: "query-activation-mutant-red",
    result: "all-query-activation-mutants-red",
    ...(synthetic === undefined ? {} : { selfTest: synthetic }),
    rows,
  })}\n`);
} finally {
  if (reports !== undefined) rmSync(reports, { recursive: true, force: true });
}

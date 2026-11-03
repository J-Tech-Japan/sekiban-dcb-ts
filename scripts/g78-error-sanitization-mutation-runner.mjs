#!/usr/bin/env node
/**
 * Prove that transport-boundary errors are sanitized behaviorally. Each
 * mutation restores the original source before the next one and its named
 * public oracle must fail with a structured assertion receipt.
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
if (vitest === undefined) throw new Error("G78 error-sanitization mutation runner: Vitest executable is unavailable");

const mutations = Object.freeze([
  {
    id: "raw-cause-preserved",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "return new ClientError(code, canonicalMessage(code, rawMessage), safeOptions);",
    to: "return new ClientError(code, canonicalMessage(code, rawMessage), { ...safeOptions, cause: error });",
    oracle: "AC4: redacts all foreign transport detail at the public read boundary",
    reason: "the public error must not retain a foreign cause",
  },
  {
    id: "raw-message-preserved",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "  void rawMessage;\n  return SAFE_MESSAGES[code] ?? SAFE_MESSAGES.transport;",
    to: "  return typeof rawMessage === \"string\" ? rawMessage : SAFE_MESSAGES[code] ?? SAFE_MESSAGES.transport;",
    oracle: "AC4: redacts all foreign transport detail at the public read boundary",
    reason: "the public error must use a canonical message, not transport text",
  },
  {
    id: "raw-partial-preserved",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "    ...(partial === undefined ? {} : { partial }),",
    to: "    ...(rawPartial === undefined ? {} : { partial: rawPartial }),",
    oracle: "AC4: foreign command partial-write keeps only validated retry metadata",
    reason: "only the validated partial-write facts may cross the boundary",
  },
  {
    id: "query-params-safe-message-deleted",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "  query_params_unsupported: \"The selected query does not support these parameters.\",\n",
    to: "",
    oracle: "AC4: query_params_unsupported stays a sanitized client error on every query path",
    reason: "the canonical safe message must stay on the allowlist",
  },
  ...[
    ["query_params_encode_failed", "The query parameters could not be encoded.", "query_params_encode_failed stays a sanitized local client error"],
    ["query_result_decode_failed", "The query response could not be decoded.", "query_result_decode_failed stays a sanitized local client error"],
    ["query_params_invalid", "The query parameters are invalid.", "executable query failure codes stay sanitized client errors"],
    ["query_scan_limit_exceeded", "The query scan limit was exceeded.", "executable query failure codes stay sanitized client errors"],
    ["query_row_invalid", "The query projection contains an invalid row.", "executable query failure codes stay sanitized client errors"],
    ["query_result_invalid", "The query handler returned an invalid result.", "executable query failure codes stay sanitized client errors"],
    ["query_handler_failed", "The query handler failed.", "executable query failure codes stay sanitized client errors"],
  ].flatMap(([code, message, oracle]) => [
    {
      id: `${code}-safe-message-deleted`,
      sourceFile: "packages/dcb-client/src/errors.ts",
      from: `  ${code}: "${message}",\n`,
      to: "",
      oracle,
      reason: `${code} must keep its canonical safe message`,
    },
    {
      id: `${code}-safe-message-wrong`,
      sourceFile: "packages/dcb-client/src/errors.ts",
      from: `${code}: "${message}"`,
      to: `${code}: "internal ${code} detail"`,
      oracle,
      reason: `${code} must not publish a substituted message`,
    },
  ]),
  {
    id: "conditional-invalid-key-safe-message-deleted",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "  conditional_commit_invalid_key: \"The idempotency key is invalid.\",\n",
    to: "",
    oracle: "invalid-key stays invalid with the canonical safe message",
    reason: "the invalid-key safe message must stay on the allowlist",
  },
  {
    id: "conditional-in-doubt-safe-message-wrong",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "conditional_commit_in_doubt: \"The conditional commit outcome is not yet verified; resend the same prepared request.\"",
    to: "conditional_commit_in_doubt: \"internal in-doubt detail\"",
    oracle: "in-doubt stays unavailable with the validated reason",
    reason: "in-doubt must keep its canonical safe message",
  },
  {
    id: "conditional-corrupt-safe-message-deleted",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "  conditional_commit_committed_state_corrupt: \"The durable conditional commit state could not be verified.\",\n",
    to: "",
    oracle: "corrupt stays unavailable without public retry fields",
    reason: "the corrupt safe message must stay on the allowlist",
  },
  {
    id: "conditional-invalid-response-safe-message-deleted",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "  conditional_commit_invalid_response: \"The conditional commit response is invalid.\",\n",
    to: "",
    oracle: "malformed response stays transport",
    reason: "the malformed-response safe message must stay on the allowlist",
  },
  {
    id: "conditional-foreign-retryable-reason-copied",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "    ...(partial === undefined ? {} : { partial }),\n  };",
    to: "    ...(partial === undefined ? {} : { partial }),\n    ...(typeof source?.retryable === \"boolean\" ? { retryable: source.retryable } : {}),\n    ...(typeof source?.reason === \"string\" ? { reason: source.reason } : {}),\n  };",
    oracle: "retryable/reason stay absent when sanitizing foreign transport errors",
    reason: "sanitized transport errors must not copy foreign retryable or reason",
  },
  {
    id: "conditional-foreign-detail-preserved",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "return new ClientError(code, canonicalMessage(code, rawMessage), safeOptions);",
    to: "return new ClientError(code, typeof rawMessage === \"string\" ? rawMessage : canonicalMessage(code, rawMessage), { ...safeOptions, cause: source });",
    oracle: "foreign-detail redaction omits raw key payload header and cause",
    reason: "sanitized errors must not retain foreign messages or causes",
  },
]);

let reports;

function fail(message) {
  throw new Error(`G78 error-sanitization mutation runner: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function reportPath(label) {
  reports ??= mkdtempSync(join(tmpdir(), "sdt-g78-error-sanitization-"));
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
    "test/g78-error-classification.spec.ts",
    "test/query-client.spec.ts",
    "test/conditional-commit-client.spec.ts",
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
        fullName: `SDT-G78 ${mutation.oracle}`,
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
    result: "all-g78-sanitization-mutants-red",
    ...(synthetic === undefined ? {} : { selfTest: synthetic }),
    rows,
  })}\n`);
} finally {
  if (reports !== undefined) rmSync(reports, { recursive: true, force: true });
}

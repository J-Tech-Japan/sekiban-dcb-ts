#!/usr/bin/env node
/**
 * Run the required SDT-G71 authority/read-consistency mutants against
 * the focused public-contract tests. Each mutation is applied to the source
 * under test, the named semantic oracle must turn red, and the original bytes
 * are restored before the next mutation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("SDT-G71 mutation runner: Vitest executable is unavailable");

const sourceFile = "packages/dcb-client/src/executor.ts";
const mutations = Object.freeze([
  {
    id: "sentinel-only-existence",
    from: "exists: true,",
    to: "exists: !empty,",
    oracle: "retains an existing empty object, ignored-event state, and sentinel state as existing",
    reason: "payload sentinel cannot replace the durable authority boolean",
  },
  {
    id: "authority-failure-as-absence",
    from: "() => transport.readTagLatestSortable!({ tag }, signal),",
    to: "() => Promise.resolve({ exists: false, lastSortableUniqueId: \"\" }),",
    oracle: "does not suppress authority failures and reports a missing capability",
    reason: "an authority refusal must not be relabelled as absence",
  },
  {
    id: "existing-empty-object-erased",
    from: "const empty = isRecord(decoded) && decoded.status === \"empty\";",
    to: "const empty = (isRecord(decoded) && decoded.status === \"empty\") || (isRecord(decoded) && Object.keys(decoded).length === 0);",
    oracle: "retains an existing empty object, ignored-event state, and sentinel state as existing",
    reason: "a decoded empty object is an existing projector result",
  },
  {
    id: "mismatched-observation-heads",
    from: "if (compareSortableUniqueId(response.lastSortedUniqueId, authority.lastSortableUniqueId) < 0) {",
    to: "if (false) {",
    oracle: "bounds authority/frontier reconciliation instead of combining mismatched observations",
    reason: "a stale consumed frontier cannot be combined with a newer authority head",
  },
  {
    id: "list-consistency-dropped",
    from: "() => transport.listQuery(withConsistency, readOptions.signal),",
    to: "() => transport.listQuery(request, readOptions.signal),",
    oracle: "carries list consistency through every adapter and refuses it elsewhere",
    reason: "a public list lane must reach each serialized transport",
  },
  {
    id: "abort-collapsed-to-transport",
    sourceFile: "packages/dcb-client/src/errors.ts",
    from: "if (abortLike(error)) {\n    code = \"aborted\";",
    to: "if (abortLike(error)) {\n    code = \"transport\";",
    oracle: "keeps refusal, abort, and transport failures distinguishable at the read boundary",
    reason: "an aborted read must not be collapsed into an ordinary transport failure",
  },
  {
    id: "composition-unsafe-option-dropped",
    sourceFile: "samples/meeting-room/src/worker.cloudflare-only.ts",
    testFile: "test/g71-composition.spec.ts",
    from: "      }, { consistency: \"unsafe\" });\n      return json(result);",
    to: "      });\n      return json(result);",
    oracle: "G71 composition: safe and unsafe pages diverge while SafeWindow holds",
    reason: "the sample's held unsafe page must include the queued event rather than silently taking the safe lane",
  },
  {
    id: "composition-safe-head-from-wrong-observation",
    sourceFile: "packages/dcb-runtime/src/mv/MaterializedViewStore.ts",
    testFile: "test/g71-composition.spec.ts",
    from: "      readHead: options.consistency === \"unsafe\" ? maxReflectedSuid(rows) : selectedInstance.lastSuid,",
    to: "      readHead: maxReflectedSuid(rows),",
    oracle: "G71 composition: safe and unsafe pages diverge while SafeWindow holds",
    reason: "a page maximum is not the safe checkpoint and makes the held empty safe page report an empty head instead of SUID A",
  },
]);

function run(args, label) {
  const reportDirectory = mkdtempSync(resolve(tmpdir(), "sdt-g71-vitest-"));
  const reportPath = resolve(reportDirectory, "vitest.json");
  try {
    const result = spawnSync(process.execPath, [vitest, ...args, "--reporter=json", "--outputFile", reportPath], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    });
    let structured;
    let reportError;
    if (existsSync(reportPath)) {
      try {
        structured = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (error) {
        reportError = `Vitest JSON report could not be parsed: ${String(error)}`;
      }
    } else {
      reportError = "Vitest did not produce a structured JSON report";
    }
    return {
      label,
      status: result.status,
      signal: result.signal,
      error: result.error === undefined ? undefined : String(result.error),
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      structured,
      reportError,
    };
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function requirePass(result) {
  if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.reportError !== undefined) {
    throw new Error(`${result.label} unexpectedly failed:\n${JSON.stringify(result, null, 2)}`);
  }
  const assertions = assertionResults(result.structured);
  const matches = assertions.filter((assertion) => isNamedOracle(assertion, currentOracle));
  if (matches.length !== 1 || matches[0].status !== "passed") {
    throw new Error(`${result.label} did not produce one passing named oracle:\n${JSON.stringify(result, null, 2)}`);
  }
}

let currentOracle;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertionResults(value) {
  if (!isRecord(value) || !Array.isArray(value.testResults)) return [];
  return value.testResults.flatMap((file) => isRecord(file) && Array.isArray(file.assertionResults) ? file.assertionResults : []);
}

function isNamedOracle(assertion, oracleName) {
  return isRecord(assertion) && assertion.title === oracleName &&
    typeof assertion.fullName === "string" && assertion.fullName.endsWith(` ${oracleName}`);
}

function semanticFailureEvidence(result, mutation) {
  const reject = (reason) => {
    throw new Error(`${mutation.id} did not produce a semantic red oracle (${reason}):\n${JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error,
      reportError: result.reportError,
      output: result.output,
      structured: result.structured,
    }, null, 2)}`);
  };
  if (result.status === 0) reject("green escape");
  if (result.status === null) reject("process did not return a status");
  if (result.signal !== null) reject(`process signal ${result.signal}`);
  if (result.error !== undefined) reject(`process error ${result.error}`);
  if (result.reportError !== undefined) reject(result.reportError);
  if (!isRecord(result.structured) || result.structured.success !== false) reject("structured report was not a failed run");
  const assertions = assertionResults(result.structured);
  const matches = assertions.filter((assertion) => isNamedOracle(assertion, mutation.oracle));
  if (matches.length !== 1) reject("named oracle was missing or ambiguous");
  const oracle = matches[0];
  if (!isRecord(oracle) || oracle.status !== "failed") reject("named oracle was skipped or did not fail");
  const failedOther = assertions.some((assertion) => isRecord(assertion) && assertion.status === "failed" && !isNamedOracle(assertion, mutation.oracle));
  if (failedOther) reject("an unrelated assertion also failed");
  const failureMessages = Array.isArray(oracle.failureMessages)
    ? oracle.failureMessages.filter((message) => typeof message === "string")
    : [];
  if (failureMessages.length === 0) reject("named oracle had no failed-assertion evidence");
  const failureText = failureMessages.join("\n");
  if (/(timed out|timeout|cannot find module|failed to load|setup|syntaxerror|referenceerror|typeerror|sigterm|sigkill|killed|unhandled)/i.test(failureText)) {
    reject("failure evidence was infrastructure/setup/timeout/process failure");
  }
  if (!/(assertionerror|expected|received|assert|to (?:be|equal|have|contain|match))/i.test(failureText)) {
    reject("failure evidence was not an assertion failure");
  }
  const summary = {
    processStatus: result.status,
    signal: result.signal,
    processError: result.error ?? null,
    reportError: result.reportError ?? null,
    report: {
      success: result.structured.success,
      numFailedTests: result.structured.numFailedTests,
      numTotalTests: result.structured.numTotalTests,
    },
    namedOracle: oracle.fullName,
    failedAssertionMessages: failureMessages,
  };
  return summary;
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.id} anchor expected once, found ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

function oracle(mutation) {
  currentOracle = mutation.oracle;
  const testFile = mutation.testFile ?? "test/g71-read-contract.spec.ts";
  return run([
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    testFile,
    "--testNamePattern",
    mutation.oracle,
  ], `G71 semantic oracle (${mutation.id})`);
}

function runMutation(mutation) {
  const path = resolve(root, mutation.sourceFile ?? sourceFile);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(oracle(mutation));
    writeFileSync(path, mutate(original, mutation), "utf8");
    const red = oracle(mutation);
    const redEvidence = semanticFailureEvidence(red, mutation);
    return { id: mutation.id, reason: mutation.reason, result: "behavioral-product-mutant-red", redEvidence };
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

function assertRejects(label, action) {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(`semantic red validator accepted ${label}`);
}

function syntheticResult({ status = 1, signal = null, error, structured }) {
  return { label: "self-test", status, signal, error, reportError: undefined, output: "", structured };
}

function semanticReport(oracle, status = "failed", failureMessages = ["AssertionError: expected 1 to be 2"]) {
  return {
    success: status === "failed" ? false : true,
    numFailedTests: status === "failed" ? 1 : 0,
    numTotalTests: 1,
    testResults: [{ assertionResults: [{ fullName: `SDT-G71 ${oracle}`, title: oracle, status, failureMessages }] }],
  };
}

function selfTest() {
  for (const mutation of mutations) {
    const original = readFileSync(resolve(root, mutation.sourceFile ?? sourceFile), "utf8");
    mutate(original, mutation);
  }
  const mutation = mutations[0];
  const semantic = semanticFailureEvidence(syntheticResult({ structured: semanticReport(mutation.oracle) }), mutation);
  assertRejects("setup/import failure", () => semanticFailureEvidence(syntheticResult({ structured: semanticReport(mutation.oracle, "failed", ["Failed to load setup file"]) }), mutation));
  assertRejects("timeout", () => semanticFailureEvidence(syntheticResult({ structured: semanticReport(mutation.oracle, "failed", ["Test timed out in 5000ms"]) }), mutation));
  assertRejects("process kill", () => semanticFailureEvidence(syntheticResult({ status: null, signal: "SIGKILL", structured: semanticReport(mutation.oracle) }), mutation));
  assertRejects("missing oracle", () => semanticFailureEvidence(syntheticResult({ structured: semanticReport("different oracle") }), mutation));
  assertRejects("skipped oracle", () => semanticFailureEvidence(syntheticResult({ structured: semanticReport(mutation.oracle, "skipped", []) }), mutation));
  assertRejects("unrelated assertion", () => semanticFailureEvidence(syntheticResult({ structured: {
    ...semanticReport(mutation.oracle),
    testResults: [{ assertionResults: [
      { fullName: `SDT-G71 ${mutation.oracle}`, title: mutation.oracle, status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] },
      { fullName: "SDT-G71 unrelated", title: "unrelated", status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] },
    ] }],
  } }), mutation));
  assertRejects("green escape", () => semanticFailureEvidence(syntheticResult({ status: 0, structured: semanticReport(mutation.oracle, "passed", []) }), mutation));
  process.stdout.write(`${JSON.stringify({
    mutations: mutations.map(({ id }) => id),
    selfTest: "anchors-and-semantic-validator",
    acceptedSemanticEvidence: semantic,
    rejectedCases: ["setup/import failure", "timeout", "process kill", "missing oracle", "skipped oracle", "unrelated assertion", "green escape"],
  })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const rows = mutations.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g71-behavioral-product-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

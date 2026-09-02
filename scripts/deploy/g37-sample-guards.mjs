#!/usr/bin/env node
/**
 * Non-live guards for the existing G37 sampler. These guards deliberately use
 * an in-memory fetch or a loopback HTTP server; they never deploy or call a
 * Cloudflare endpoint.
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureG47HistoryLengthSample } from "./g37-sample.mjs";

const REPO_ROOT = process.cwd();
const SAMPLER = join(REPO_ROOT, "scripts/deploy/g37-sample.mjs");
const SOURCE_COMMIT = "a".repeat(40);

function fail(message) {
  throw new Error(`g37-sample-guards:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertLedgerHistoryMatchesWindow(window, context) {
  assert(Array.isArray(window.ledger), `${context} has no ledger`);
  window.ledger.forEach((entry, index) => {
    const row = index + 1;
    assert(entry.historyLengthBefore === window.historyLengthBeforeWindow,
      `${context} ledger row ${row} before-history disagrees with window`);
    assert(entry.historyLengthAfter === window.historyLengthAfterWindow,
      `${context} ledger row ${row} after-history disagrees with window`);
  });
}

function assertLedgerHistoryMutationIsRejected(window) {
  const mutated = structuredClone(window);
  mutated.ledger[0].historyLengthAfter += 1;
  let rejected = false;
  try {
    assertLedgerHistoryMatchesWindow(mutated, "negative ledger mutation");
  } catch {
    rejected = true;
  }
  assert(rejected, "negative ledger history mutation was accepted");
  return true;
}

function response(status, body, requestNumber) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cf-ray": requestNumber.toString(16).padStart(16, "0") + "-SJC",
    },
  });
}

function committedBody(count) {
  return {
    writtenEvents: Array.from({ length: count }, (_unused, index) => ({
      sortableUniqueIdValue: String(index + 1).padStart(30, "0"),
    })),
    tagWriteResults: [],
  };
}

async function fullHistoryLengthProfileGuard() {
  const originalFetch = globalThis.fetch;
  let requestNumber = 0;
  let tagLatestCount = 0;
  let commitCount = 0;
  const tagStateCalls = new Map();
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body === undefined ? {} : JSON.parse(init.body);
    requestNumber += 1;
    if (path.endsWith("/tag-latest-sortable")) {
      tagLatestCount += 1;
      return response(200, { exists: false, lastSortableUniqueId: "" }, requestNumber);
    }
    if (path.endsWith("/commit")) {
      commitCount += 1;
      return response(200, committedBody(body.eventCandidates.length), requestNumber);
    }
    if (path.endsWith("/tag-state")) {
      const tagStateId = body.tagStateId;
      const isLong = tagStateId.includes("-long:RoomProjector");
      const key = isLong ? "long" : "short";
      const callCount = (tagStateCalls.get(key) ?? 0) + 1;
      tagStateCalls.set(key, callCount);
      if (isLong && callCount < 79) {
        return response(503, { code: "tag_state_rebuild_in_progress" }, requestNumber);
      }
      return response(200, {
        payload: "e30=",
        version: 1,
        lastSortedUniqueId: "1".repeat(30),
        tagGroup: "room",
        tagContent: key,
        tagProjector: "RoomProjector",
        tagPayloadName: "RoomState",
        projectorVersion: "1",
      }, requestNumber);
    }
    return response(404, { error: "unexpected guard path" }, requestNumber);
  };

  try {
    const sample = await captureG47HistoryLengthSample({
      baseUrl: "https://guard.invalid",
      token: "guard-conformance-token",
      accountId: "guard-account",
      observabilityToken: undefined,
      observabilityTokenReason: "guard token absent",
      template: {},
      candidate: "guard-full-history",
      sourceCommit: SOURCE_COMMIT,
      serviceId: "guard-service-full",
      sampleCount: 50,
      deployment: { id: "guard-version", number: 1, message: "guard" },
    });
    assert(sample.serviceId === "guard-service-full", "full profile omitted service identity");
    assert(sample.windows.length === 2, "full profile did not produce two windows");
    assert(sample.windows[0].historyLengthBeforeWindow === 1, "short history length was not one");
    assert(sample.windows[1].historyLengthBeforeWindow === 5_000, "long history length was not 5000");
    assert(sample.windows.every((window) => window.sampleCount === 50), "full profile did not sample 50 reads per window");
    assert(sample.windows[0].coldReplay.requestCount === 1, "short cold replay count changed");
    assert(sample.windows[1].coldReplay.requestCount === 79, "long cold replay count changed");
    assert(sample.windows.every((window) => window.warmup.discardedResponse === true), "warm-up was not discarded");
    assert(sample.windows.every((window) => window.warmup.kind === "single discarded READY warm-up read"), "warm-up protocol changed");
    assert(sample.comparison.claim.includes("for a WARM TagStateDO"), "warm condition was dropped from claim");
    sample.windows.forEach((window) => assertLedgerHistoryMatchesWindow(window, `${window.label} history`));
    const negativeLedgerMutationRejected = assertLedgerHistoryMutationIsRejected(sample.windows[0]);
    assert(tagLatestCount === 2, "full profile performed an unexpected tag-latest read");
    assert(commitCount === 11, "full profile seed commit count changed");
    assert(tagStateCalls.get("short") === 52, "short TagState call count did not equal cold + warm-up + 50");
    assert(tagStateCalls.get("long") === 130, "long TagState call count did not equal cold + warm-up + 50");
    return {
      passed: true,
      serviceId: sample.serviceId,
      windows: sample.windows.map((window) => ({
        label: window.label,
        historyLength: window.historyLengthBeforeWindow,
        coldReplayReads: window.coldReplay.requestCount,
        warmupReads: 1,
        sampledReads: window.sampleCount,
      })),
      ledgerRowsChecked: sample.windows.reduce((total, window) => total + window.ledger.length, 0),
      negativeLedgerMutationRejected,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("guard server did not expose a port"));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function runSampler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SAMPLER, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function firstSeedPartialWriteGuard() {
  const scratch = mkdtempSync(join(tmpdir(), "sdt-g37-guard-partial-"));
  const tokenFile = join(scratch, "conformance-token");
  const output = join(scratch, "should-not-exist.json");
  writeFileSync(tokenFile, "guard-conformance-token\n", { mode: 0o600 });
  let requestNumber = 0;
  let commitCount = 0;
  const server = createServer(async (request, stream) => {
    requestNumber += 1;
    request.resume();
    const path = new URL(request.url ?? "/", "http://guard.invalid").pathname;
    stream.setHeader("content-type", "application/json");
    stream.setHeader("cf-ray", requestNumber.toString(16).padStart(16, "0") + "-SJC");
    if (path.endsWith("/tag-latest-sortable")) {
      stream.statusCode = 200;
      stream.end(JSON.stringify({ exists: false, lastSortableUniqueId: "" }));
      return;
    }
    if (path.endsWith("/commit")) {
      commitCount += 1;
      stream.statusCode = 500;
      stream.end(JSON.stringify({
        error: "serialized commit partially failed",
        code: "partial_write",
        partial: { writtenEventIds: [], failedEventIds: ["guard"], writtenTags: [], missingTags: ["guard"], eventsDeleted: false, retryable: false },
      }));
      return;
    }
    stream.statusCode = 404;
    stream.end(JSON.stringify({ error: "unexpected guard path" }));
  });
  try {
    const baseUrl = await listen(server);
    const result = await runSampler([
      "--base-url", baseUrl,
      "--token-file", tokenFile,
      "--account-id", "guard-account",
      "--service-id", "guard-service-partial",
      "--candidate", "guard-first-seed",
      "--source-commit", "b".repeat(40),
      "--profile", "history-length",
      "--samples", "50",
      "--output", output,
    ]);
    assert(result.code !== 0, "partial-write guard subprocess unexpectedly succeeded");
    assert(result.stderr.includes("partial_write"), "partial-write guard did not expose partial_write");
    assert(commitCount === 1, "partial-write guard made more than the first seed request");
    assert(!existsSync(output), "partial-write guard left a measurement artifact");
    return { passed: true, exitCode: result.code, measurementArtifactExists: false, firstSeedRequests: commitCount };
  } finally {
    await close(server);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function defaultSingleProfileGuard() {
  const scratch = mkdtempSync(join(tmpdir(), "sdt-g37-guard-single-"));
  const tokenFile = join(scratch, "conformance-token");
  const output = join(scratch, "single.json");
  writeFileSync(tokenFile, "guard-conformance-token\n", { mode: 0o600 });
  let requestNumber = 0;
  let tagLatestCount = 0;
  let commitCount = 0;
  const server = createServer(async (request, stream) => {
    requestNumber += 1;
    request.resume();
    const path = new URL(request.url ?? "/", "http://guard.invalid").pathname;
    stream.setHeader("content-type", "application/json");
    stream.setHeader("cf-ray", requestNumber.toString(16).padStart(16, "0") + "-SJC");
    if (path.endsWith("/tag-latest-sortable")) {
      tagLatestCount += 1;
      stream.statusCode = 200;
      stream.end(JSON.stringify({ exists: false, lastSortableUniqueId: "" }));
      return;
    }
    if (path.endsWith("/commit")) {
      commitCount += 1;
      stream.statusCode = 200;
      stream.end(JSON.stringify(committedBody(1)));
      return;
    }
    stream.statusCode = 404;
    stream.end(JSON.stringify({ error: "unexpected guard path" }));
  });
  try {
    const baseUrl = await listen(server);
    const result = await runSampler([
      "--base-url", baseUrl,
      "--token-file", tokenFile,
      "--account-id", "guard-account",
      "--service-id", "guard-service-single",
      "--candidate", "guard-default-single",
      "--source-commit", "c".repeat(40),
      "--samples", "3",
      "--output", output,
    ]);
    assert(result.code === 0, `default single guard failed: ${result.stderr}`);
    assert(existsSync(output), "default single guard did not write its artifact");
    const sample = JSON.parse(readFileSync(output, "utf8"));
    assert(sample.task === "SDT-G37", "default profile no longer uses the G37 flow");
    assert(sample.serviceId === "guard-service-single", "default profile omitted service identity");
    assert(sample.sampleCount === 3 && sample.client.count === 3, "default profile sample count changed");
    assert(sample.telemetry.status === "unavailable", "default profile telemetry fallback changed");
    assert(tagLatestCount === 1 && commitCount === 4, "default profile request sequence changed");
    return { passed: true, serviceId: sample.serviceId, sampleCount: sample.sampleCount, measurementArtifactExists: true };
  } finally {
    await close(server);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const results = {
  fullHistoryLengthProfile: await fullHistoryLengthProfileGuard(),
  firstSeedPartialWriteNoArtifact: await firstSeedPartialWriteGuard(),
  defaultSingleProfileRegression: await defaultSingleProfileGuard(),
};
console.log(JSON.stringify(results, null, 2));

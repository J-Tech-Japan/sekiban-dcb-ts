#!/usr/bin/env node
/**
 * SDT-G69 strict-order, lag-estimate, and append-only receipt guard.
 *
 * The baseline is the real allocator -> Tag -> D1 -> G44/G62 proof. Each
 * mutation is applied only in this child-process oracle and restored in a
 * finally block. A green mutant is a failed guard, not an accepted result.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const testFile = "test/g69-ordering.spec.ts";
const storeFile = "packages/dcb-runtime/src/store/D1EventStore.ts";
const catchUpFile = "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts";
const receiptFile = "packages/dcb-runtime/src/diagnostics/G69AdmissionAttempt.ts";
const configFile = "vitest.g69.config.ts";
const reportFile = ".artifacts/sdt-g69-ordering-red-green.json";

const lagSqlAnchor = `            AND NOT EXISTS (
              SELECT 1 FROM dcb_events contradictory
               WHERE contradictory."ServiceId" = ? AND contradictory."Id" = ?
                 AND (contradictory."SortableUniqueId" COLLATE BINARY <> ? COLLATE BINARY
                   OR contradictory."Payload" <> ? OR contradictory."EventType" <> ?
                   OR contradictory."Tags" <> ?)
            )
         ON CONFLICT (service_id) DO UPDATE`;
const lagSqlMutant = `            AND NOT EXISTS (
              SELECT 1 FROM dcb_events contradictory
               WHERE contradictory."ServiceId" = ? AND contradictory."Id" = ?
                 AND (contradictory."SortableUniqueId" COLLATE BINARY <> ? COLLATE BINARY
                   OR contradictory."Payload" <> ? OR contradictory."EventType" <> ?
                   OR contradictory."Tags" <> ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM dcb_events prior
               WHERE prior."ServiceId" = ?
                 AND prior."SortableUniqueId" COLLATE BINARY > ? COLLATE BINARY
            )
         ON CONFLICT (service_id) DO UPDATE`;
const lagBindAnchor = `        message.eventId,
        message.suid,
        message.payload,
        incomingEventType,
        tagsJson,
      ),
    ];`;
const lagBindMutant = `        message.eventId,
        message.suid,
        message.payload,
        incomingEventType,
        tagsJson,
        message.serviceId,
        message.suid,
      ),
    ];`;

const mutations = [
  {
    name: "omit-late-lower-suid-detector",
    file: catchUpFile,
    testPattern: "real allocation race",
    replacements: [{
      from: "      const lateLower = await this.source.findLateLowerSuid?.(serviceId, priorSuid, checkpointUpdatedAt);",
      to: "      const lateLower = undefined;",
    }],
    reason: "the real lower-after-higher allocator proof must fail closed",
  },
  {
    name: "restore-higher-suid-lag-exclusion",
    file: storeFile,
    testPattern: "lag estimate",
    replacements: [{ from: lagSqlAnchor, to: lagSqlMutant }, { from: lagBindAnchor, to: lagBindMutant }],
    reason: "a lower SUID and its replay must still update the observed lag estimate",
  },
  {
    name: "omit-append-only-admission-receipt",
    file: receiptFile,
    testPattern: "lag estimate",
    replacements: [{
      from: "  const insert = database.prepare(\n    `INSERT INTO serialized_dcb_g69_admission_attempts",
      to: "  return;\n  const insert = database.prepare(\n    `INSERT INTO serialized_dcb_g69_admission_attempts",
    }],
    reason: "each recordDelivery attempt must leave one immutable receipt row",
  },
  {
    name: "await-diagnostic-receipt-on-core-path",
    file: storeFile,
    testPattern: "returns core admission",
    replacements: [{
      from: "    void this.bestEffortG69AdmissionAttempt(",
      to: "    await this.bestEffortG69AdmissionAttempt(",
    }],
    reason: "a stalled diagnostic observation must not hold core admission or Queue disposition",
  },
];

function fail(message) {
  throw new Error(`SDT-G69 ordering guard failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function applyMutation(source, mutation) {
  let result = source;
  for (const replacement of mutation.replacements) {
    const count = result.split(replacement.from).length - 1;
    if (count !== 1) fail(`${mutation.name} anchor expected once, found ${count}`);
    result = result.replace(replacement.from, replacement.to);
  }
  return result;
}

function vitestPath() {
  const local = resolve(root, "node_modules/vitest/vitest.mjs");
  if (existsSync(local)) return local;
  const parent = resolve(root, "..", "node_modules/vitest/vitest.mjs");
  if (existsSync(parent)) return parent;
  fail("vitest runner was not found in the worktree or parent checkout");
}

function runOracle(pattern) {
  const args = [vitestPath(), "run", "--config", configFile, "--no-cache", "--maxWorkers=1", testFile, "--testNamePattern", pattern];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    timeout: 3_000,
  });
  return {
    command: [process.execPath, ...args].join(" "),
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function tail(value, limit = 4_000) {
  return value.length <= limit ? value : value.slice(-limit);
}

function selfTest() {
  if (!existsSync(resolve(root, configFile))) fail(`missing ${configFile}`);
  if (!read(testFile).includes("real allocation race")) fail("real allocation oracle is missing");
  if (!read(testFile).includes("append-only")) fail("append-only oracle is missing");
  if (!read(catchUpFile).includes("findLateLowerSuid")) fail("strict-order detector call is missing");
  if (!read(storeFile).includes("findLateLowerSuid(")) fail("D1 strict-order detector is missing");
  if (!read(storeFile).includes("ON CONFLICT (service_id) DO UPDATE")) fail("lag-estimate upsert is missing");
  if (!read(receiptFile).includes("INSERT INTO serialized_dcb_g69_admission_attempts")) fail("append-only receipt insert is missing");
  for (const mutation of mutations) applyMutation(read(mutation.file), mutation);
  process.stdout.write(`${JSON.stringify({ selfTest: "g69-ordering-anchors-unique", mutations: mutations.map(({ name }) => name) })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const baseline = runOracle("real allocation race|lag estimate");
  if (baseline.exitCode !== 0) fail(`baseline oracle was not green (exit ${baseline.exitCode})\n${tail(baseline.stdout + baseline.stderr)}`);
  const rows = [];
  for (const mutation of mutations) {
    const path = resolve(root, mutation.file);
    const original = readFileSync(path, "utf8");
    let mutant;
    try {
      writeFileSync(path, applyMutation(original, mutation), "utf8");
      mutant = runOracle(mutation.testPattern);
    } finally {
      writeFileSync(path, original, "utf8");
    }
    if (readFileSync(path, "utf8") !== original) fail(`${mutation.name} was not restored`);
    if (mutant.exitCode === 0) fail(`${mutation.name} unexpectedly stayed green: ${mutation.reason}`);
    rows.push({
      name: mutation.name,
      status: "red",
      reason: mutation.reason,
      command: mutant.command,
      exitCode: mutant.exitCode,
      signal: mutant.signal,
      outputTail: tail(mutant.stdout + mutant.stderr),
    });
  }
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportFile), `${JSON.stringify({
    schema: "sdt-g69-ordering-red-green/v1",
    status: "pass",
    baseline: { command: baseline.command, exitCode: baseline.exitCode, outputTail: tail(baseline.stdout + baseline.stderr) },
    mutants: rows,
    restored: true,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g69-ordering", status: "pass", report: reportFile, mutants: rows.map(({ name, exitCode }) => ({ name, exitCode })) })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

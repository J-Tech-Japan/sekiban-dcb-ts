#!/usr/bin/env node
/**
 * Executes one deliberately small production-source mutation per immutable
 * G32 allocator row. This is intentionally not a source-text coverage check:
 * each mutation is built and its named Vitest oracle must fail while an
 * unrelated row still passes. The original source is restored and rebuilt in
 * a finally block after every run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

const files = Object.freeze({
  suid: "packages/dcb-runtime/src/allocator/SortableUniqueId.ts",
  order: "packages/dcb-runtime/src/allocator/OrderClock.ts",
  allocator: "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts",
  safeWindow: "packages/dcb-runtime/src/safeWindow.ts",
});

/** Every required golden row owns one exact, independently executable mutant. */
export const SUID_MUTATIONS = Object.freeze([
  { rowId: "M1", file: files.suid, from: "const ticksText = value.slice(0, SORTABLE_UNIQUE_ID_TICKS_DIGITS);", to: "const ticksText = value.slice(SORTABLE_UNIQUE_ID_TICKS_DIGITS);", unrelatedRowId: "M2" },
  { rowId: "M2", file: files.suid, from: "milliseconds * DOTNET_TICKS_PER_MILLISECOND + DOTNET_UNIX_EPOCH_TICKS", to: "milliseconds * 1n + DOTNET_UNIX_EPOCH_TICKS", unrelatedRowId: "M4" },
  { rowId: "M2a", file: files.order, from: "physicalTicks > observedTicks + 1n", to: "physicalTicks <= observedTicks + 1n", unrelatedRowId: "M3" },
  { rowId: "M2b", file: files.order, from: ": observedTicks + 1n;", to: ": observedTicks;", unrelatedRowId: "M2a" },
  { rowId: "M3", file: files.suid, from: "const ticks = milliseconds * DOTNET_TICKS_PER_MILLISECOND + DOTNET_UNIX_EPOCH_TICKS;", to: "const ticks = BigInt(Number(milliseconds) * Number(DOTNET_TICKS_PER_MILLISECOND)) + DOTNET_UNIX_EPOCH_TICKS;", unrelatedRowId: "M2" },
  { rowId: "M4", file: files.allocator, from: "vector: existing,\n            created: false,", to: "vector: { ...existing, candidates: [] },\n            created: false,", unrelatedRowId: "M5" },
  { rowId: "M5", file: files.allocator, from: "if (input.faultInjection === \"between-vector-and-watermark\") {", to: "if (false && input.faultInjection === \"between-vector-and-watermark\") {", unrelatedRowId: "M4" },
  { rowId: "M6", file: files.suid, from: "const LEGACY_PREFIXED_SUID = /^suid-[0-9]+$/;", to: "const LEGACY_PREFIXED_SUID = /^never-a-legacy-suid$/;", unrelatedRowId: "M7" },
  { rowId: "M7", file: files.suid, from: "export const DOTNET_MAX_TICKS = 3_155_378_975_999_999_999n;", to: "export const DOTNET_MAX_TICKS = 3_155_378_975_999_999_999_999n;", unrelatedRowId: "M6" },
  { rowId: "M8", file: files.safeWindow, from: "export const PUBLISHED_SAFE_WINDOW_MS = 20_000;", to: "export const PUBLISHED_SAFE_WINDOW_MS = 5_000;", unrelatedRowId: "M7" },
  { rowId: "M9", file: files.suid, from: "const LEGACY_PREFIXED_SUID = /^suid-[0-9]+$/;", to: "const LEGACY_PREFIXED_SUID = /^never-a-legacy-suid$/;", unrelatedRowId: "M8" },
  { rowId: "M10", file: files.allocator, from: "} catch (error) {\n          throw error instanceof OrderClockReadError\n            ? error\n            : new OrderClockReadError(\"Order clock failed before allocation write\", { cause: error });\n        }", to: "} catch {\n          clockTick = 0n;\n        }", unrelatedRowId: "M9" },
  { rowId: "M11", file: files.allocator, from: "const shouldWarn = rollback && state.lastRollbackWarningFingerprint !== warningFingerprint;", to: "const shouldWarn = false;", unrelatedRowId: "M12" },
  { rowId: "M12", file: files.allocator, from: "clockTick = this.orderClock.tick();", to: "clockTick = BigInt(input.candidates[0]!.eventId.length);", unrelatedRowId: "M8" },
]);

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    label,
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, rowId) {
  if (result.status !== 0) return;
  throw new Error(`${rowId} mutant was vacuous: its named production oracle remained green`);
}

function testRow(rowId) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g32-suid-rows.spec.ts",
    // Vitest matches the complete suite-qualified title, so this precise
    // row token is intentionally not anchored at the beginning.
    "--testNamePattern", `${rowId} `,
  ], `SUID row ${rowId}`);
}

function rebuild() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.rowId} mutation anchor expected exactly once in ${mutation.file}, received ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function execute(mutation) {
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, "utf8");
  try {
    // The initial build and each previous finally leave original production
    // output in place; rebuilding it again here would not add evidence.
    requirePass(testRow(mutation.rowId));

    writeFileSync(path, mutate(original, mutation), "utf8");
    requirePass(rebuild());
    requireRed(testRow(mutation.rowId), mutation.rowId);
    requirePass(testRow(mutation.unrelatedRowId));
  } finally {
    writeFileSync(path, original, "utf8");
    requirePass(rebuild());
  }
  return Object.freeze({ rowId: mutation.rowId, unrelatedRowId: mutation.unrelatedRowId, result: "red-with-unrelated-green" });
}

function verifyMatrix() {
  const rowIds = SUID_MUTATIONS.map((mutation) => mutation.rowId);
  if (new Set(rowIds).size !== rowIds.length) throw new Error("SUID mutation matrix has duplicate row IDs");
  for (const mutation of SUID_MUTATIONS) {
    if (!rowIds.includes(mutation.unrelatedRowId)) throw new Error(`${mutation.rowId} references an unknown unrelated row`);
  }
}

function main() {
  verifyMatrix();
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ rows: SUID_MUTATIONS.map((entry) => entry.rowId), selfTest: "matrix-valid" })}\n`);
    return;
  }
  requirePass(rebuild());
  const results = [];
  for (const mutation of SUID_MUTATIONS) results.push(execute(mutation));
  process.stdout.write(`${JSON.stringify({ rows: results, result: "all-production-mutants-red" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

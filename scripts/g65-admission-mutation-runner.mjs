#!/usr/bin/env node
/**
 * SDT-G65 runtime mutation proof. The mutant removes the production
 * D1EventStore identity/idempotence rejection and changes the event conflict
 * action to an overwrite. The real SQLite direct-first/Queue-first/replay
 * oracle must then fail on the conflicting replay; an accepted mutant is a
 * guard failure, never a red receipt.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/store/D1EventStore.ts";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const oracleTitle = "uses the real shared D1 path for direct-first and Queue-first admission, duplicate replay, and conflict";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runOracle(label) {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g65-admission.spec.ts",
    "--testNamePattern", oracleTitle,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result) {
  if (result.status !== 0) return;
  throw new Error("production idempotence-removal mutant unexpectedly passed the real replay/conflict oracle");
}

function replaceOnce(source, from, to, label) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) throw new Error(`${label} mutation anchor expected once, found ${occurrences}`);
  return source.replace(from, to);
}

function mutate(source) {
  let mutant = replaceOnce(
    source,
    `if (
      stored.suid !== message.suid ||
      stored.payload !== message.payload ||
      JSON.stringify(stored.eventTags) !== tagsJson ||
      stored.eventType !== incomingEventType ||
      (requiresGlobalReceipt && stored.eventDigest !== message.completeness.eventDigest) ||
      stored.timestamp !== timestamp ||
      stored.causationId !== metadata.causationId ||
      stored.correlationId !== metadata.correlationId ||
      stored.executedUser !== metadata.executedUser
    ) {`,
    `if (false && (
      stored.suid !== message.suid ||
      stored.payload !== message.payload ||
      JSON.stringify(stored.eventTags) !== tagsJson ||
      stored.eventType !== incomingEventType ||
      (requiresGlobalReceipt && stored.eventDigest !== message.completeness.eventDigest) ||
      stored.timestamp !== timestamp ||
      stored.causationId !== metadata.causationId ||
      stored.correlationId !== metadata.correlationId ||
      stored.executedUser !== metadata.executedUser
    )) {`,
    "stored identity-conflict guard",
  );
  mutant = replaceOnce(
    mutant,
    'ON CONFLICT ("ServiceId", "Id") DO NOTHING',
    'ON CONFLICT ("ServiceId", "Id") DO UPDATE SET "Payload" = excluded."Payload"',
    "event idempotence conflict action",
  );
  return mutant;
}

function writeReceipt(target, receipt) {
  if (target === undefined) return;
  const path = resolve(root, target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

function main() {
  const receiptPath = argument("--receipt");
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  const before = runOracle("real G65 replay/conflict oracle before mutation");
  requirePass(before);
  let mutantResult;
  try {
    writeFileSync(sourcePath, mutate(original), "utf8");
    mutantResult = runOracle("real G65 replay/conflict oracle under production idempotence-removal mutant");
    requireRed(mutantResult);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
  const receipt = {
    guard: "SDT-G65 production idempotence-removal mutant",
    status: "green",
    oracleTitle,
    sourceFile,
    redBeforeGreen: {
      status: "red",
      expectedFailure: true,
      exitCode: mutantResult.status,
      output: mutantResult.output,
    },
    green: { status: "green", exitCode: before.status },
    mutant: "removed storedBefore identity rejection and changed event conflict DO NOTHING to overwrite",
  };
  writeReceipt(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

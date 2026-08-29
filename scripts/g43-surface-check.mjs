#!/usr/bin/env node
/**
 * AC1/AC5 surface guard. G43 is an in-place storage change: the scanner is
 * DO-internal, and neither the receiver/tombstone Workers nor a separate G43
 * Worker/configuration may acquire a new public surface.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function fail(message) {
  throw new Error(`G43 surface check failed: ${message}`);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

function between(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) fail(`could not locate ${start}`);
  return text.slice(from, to);
}

export function assertG43Surface(snapshot) {
  const { tagSource, receiver, tombstone, receiverConfig, tombstoneConfig, rootFiles } = snapshot;
  if (!tagSource.includes("initializeTagSqlSchema")) fail("normal Tag DO does not initialize the normalized SQL schema");
  if (tagSource.includes('pathname === "/outbox/scan"')) fail("source scanner was exposed as a role-facing HTTP route");
  if (!tagSource.includes("async g43ScanSourceObligations")) fail("internal source obligation scanner is absent");

  const append = between(tagSource, "private async appendSql(", "private async acquireSql(");
  if (append.includes("readStoredRecord(")) fail("append path rehydrates whole tag history");

  const scanner = between(tagSource, "private async scanOutboxObligations(", "/** Record a retry");
  for (const forbidden of ["pendingOutbox(", "autoDrainOutbox(", "DOWNSTREAM_QUEUE", "DOWNSTREAM_DOORBELL"]) {
    if (scanner.includes(forbidden)) fail(`source scanner shares delivery path token ${forbidden}`);
  }

  for (const [name, source] of [
    ["G38 receiver", receiver],
    ["G38 tombstone", tombstone],
    ["G38 receiver config", receiverConfig],
    ["G38 tombstone config", tombstoneConfig],
  ]) {
    if (/\bg43\b/i.test(source)) fail(`${name} unexpectedly contains G43 spike material`);
  }
  if (rootFiles.some((name) => /^wrangler\.g43(?:[.-]|$)/.test(name))) {
    fail("a separate G43 Worker configuration exists");
  }
}

function snapshot() {
  return {
    tagSource: read("packages/dcb-runtime/src/tag/TagDurableObject.ts"),
    receiver: read("samples/meeting-room/src/worker.g38-receiver.ts"),
    tombstone: read("samples/meeting-room/src/worker.g38-tombstone.ts"),
    receiverConfig: read("samples/meeting-room/wrangler.g38-receiver.jsonc"),
    tombstoneConfig: read("samples/meeting-room/wrangler.g38-old-receiver-tombstone.jsonc"),
    rootFiles: readdirSync(root),
  };
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try {
    assertG43Surface(value);
  } catch {
    return;
  }
  fail(`forced-red mutation was accepted: ${label}`);
}

function selfTest() {
  assertG43Surface(snapshot());
  expectRed((value) => { value.tagSource = value.tagSource.replace("async g43ScanSourceObligations", 'pathname === "/outbox/scan"\nasync g43ScanSourceObligations'); }, "public scanner route");
  expectRed((value) => { value.tagSource = value.tagSource.replace('const serviceId = suppliedServiceId ?? "";', 'const serviceId = suppliedServiceId ?? "";\n    this.readStoredRecord(tag);'); }, "whole-history append");
  expectRed((value) => { value.receiver = `${value.receiver}\n// g43`; }, "receiver contamination");
  process.stdout.write(`${JSON.stringify({ selfTest: "surface-and-isolation-mutations-red" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG43Surface(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g43-in-place-surface-check-passed", g43WorkerConfigPresent: existsSync(resolve(root, "wrangler.g43-spike.jsonc")) })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

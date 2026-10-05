#!/usr/bin/env node
/** G43 in-place surface guard for the current Worker composition. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const CURRENT_CONFIGS = ["wrangler.jsonc", "samples/meeting-room/wrangler.jsonc", "samples/meeting-room/wrangler.cloudflare-only.jsonc"];

function fail(message) { throw new Error(`G43 surface check failed: ${message}`); }
function read(relative) { return readFileSync(resolve(root, relative), "utf8"); }
function between(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) fail(`could not locate ${start}`);
  return text.slice(from, to);
}

export function assertG43Surface(snapshot) {
  const { tagSource, currentWorker, receiver, configs, rootFiles } = snapshot;
  if (!tagSource.includes("initializeTagSqlSchema")) fail("normal Tag DO does not initialize the normalized SQL schema");
  if (tagSource.includes('pathname === "/outbox/scan"')) fail("source scanner was exposed as a role-facing HTTP route");
  if (!tagSource.includes("async g43ScanSourceObligations")) fail("internal source obligation scanner is absent");
  const append = between(tagSource, "private async appendSql(", "private async acquireSql(");
  if (append.includes("readStoredRecord(")) fail("append path rehydrates whole tag history");
  const scanner = between(tagSource, "private async scanOutboxObligations(", "/** Record a retry");
  for (const forbidden of ["pendingOutbox(", "autoDrainOutbox(", "DOWNSTREAM_QUEUE", "DOWNSTREAM_DOORBELL"]) if (scanner.includes(forbidden)) fail(`source scanner shares delivery path token ${forbidden}`);
  for (const [name, source] of [["current Worker", currentWorker], ["current embedded receiver", receiver]]) if (/\bg43\b/i.test(source)) fail(`current-surface-contamination: ${name} unexpectedly contains G43 spike material`);
  const names = configs.map(([name]) => name);
  if (JSON.stringify(names) !== JSON.stringify(CURRENT_CONFIGS)) fail("separate-g43-config: current config set changed");
  if (rootFiles.some((name) => /^wrangler\.g43(?:[.-]|$)/.test(name))) fail("separate-g43-config: a separate G43 Worker configuration exists");
}

function snapshot() {
  return {
    tagSource: read("packages/dcb-runtime/src/tag/TagDurableObject.ts"),
    currentWorker: read("samples/meeting-room/src/worker.cloudflare-only.ts"),
    receiver: read("samples/meeting-room/src/worker.g38-receiver.ts"),
    configs: CURRENT_CONFIGS.map((path) => [path, read(path)]),
    rootFiles: readdirSync(root),
  };
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try { assertG43Surface(value); } catch { return; }
  fail(`forced-red mutation was accepted: ${label}`);
}

function selfTest() {
  assertG43Surface(snapshot());
  expectRed((value) => { value.tagSource = value.tagSource.replace("async g43ScanSourceObligations", 'pathname === "/outbox/scan"\nasync g43ScanSourceObligations'); }, "public scanner route");
  expectRed((value) => { value.tagSource = value.tagSource.replace('const serviceId = suppliedServiceId ?? "";', 'const serviceId = suppliedServiceId ?? "";\n    this.readStoredRecord(tag);'); }, "whole-history append");
  expectRed((value) => { value.receiver = `${value.receiver}\n// g43`; }, "current-surface-contamination");
  expectRed((value) => { value.configs[0][0] = "wrangler.g43-spike.jsonc"; }, "separate-g43-config");
  process.stdout.write(`${JSON.stringify({ selfTest: "surface-and-isolation-mutations-red", labels: ["public scanner route", "whole-history append", "current-surface-contamination", "separate-g43-config"] })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG43Surface(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g43-in-place-surface-check-passed", configs: CURRENT_CONFIGS })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

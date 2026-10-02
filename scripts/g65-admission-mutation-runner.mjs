#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/store/D1EventStore.ts";
const oracleTitle = "uses the real shared D1 path for direct-first and Queue-first admission, duplicate replay, and conflict";

function fail(message) {
  throw new Error(`SDT-G65 idempotence check failed: ${message}`);
}

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) fail(`${label} anchor expected once, found ${count}`);
  return source.replace(from, to);
}

function mutate(source) {
  let mutant = replaceOnce(
    source,
    "if (storedBefore !== undefined && (",
    "if (false && storedBefore !== undefined && (",
    "idempotence preflight",
  );
  mutant = replaceOnce(
    mutant,
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
    "idempotence conflict preflight",
  );
  return replaceOnce(
    mutant,
    'ON CONFLICT ("ServiceId", "Id") DO NOTHING',
    'ON CONFLICT ("ServiceId", "Id") DO UPDATE SET "Payload" = excluded."Payload"',
    "idempotence conflict action",
  );
}

function run(label) {
  const result = spawnSync(process.execPath, [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    "test/g65-admission.spec.ts",
    "--testNamePattern", oracleTitle,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    label,
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
}

function main() {
  const absolutePath = resolve(root, sourceFile);
  const original = readFileSync(absolutePath, "utf8");
  const baseline = run("idempotence-removal baseline");
  if (baseline.exitCode !== 0) fail(`baseline was red (exit ${baseline.exitCode})`);
  let mutant;
  try {
    writeFileSync(absolutePath, mutate(original), "utf8");
    mutant = run("idempotence-removal mutant");
  } finally {
    writeFileSync(absolutePath, original, "utf8");
  }
  if (readFileSync(absolutePath, "utf8") !== original) fail("source mutation was not restored");
  if (mutant.exitCode === 0) fail("idempotence-removal unexpectedly stayed green");
  process.stdout.write(`${JSON.stringify({
    check: "g65-admission-mutation-runner",
    mutants: [{ label: "idempotence-removal", oracle: `test/g65-admission.spec.ts :: ${oracleTitle}`, baselineExitCode: baseline.exitCode, mutantExitCode: mutant.exitCode, result: "red" }],
  })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

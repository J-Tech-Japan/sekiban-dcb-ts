#!/usr/bin/env node
/**
 * SDT-G53 downstream identity regression oracle. The real G44 fixture drains
 * a scoped Tag source, invokes the Queue receiver adapter, persists global
 * D1, then reads the receipt back before source acknowledgement. Replacing
 * just the drain hop with the retired `service|tag` name must make that
 * fixture fail. The source is restored and rebuilt on every exit path.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/downstream/OutboxDrain.ts";
const oracle = "a canonical scoped source drains through the Queue adapter into global D1 before acknowledgement";
const mutant = Object.freeze({
  id: "outbox-drain-retired-service-pipe-tag-name",
  from: `const stub = env.TAG.get(scopeIdFor(env.TAG, {
    serviceId: input.serviceId,
    doClass: "tag",
    identity: input.tag,
  }));`,
  to: "const stub = env.TAG.get(env.TAG.idFromName(`${input.serviceId}|${input.tag}`));",
});

function run(program, args, label) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result) {
  if (result.status !== 0) return;
  throw new Error("SDT-G53 downstream old-name mutant was vacuous: Queue-to-global-D1 fixture remained green");
}

function mutate(source) {
  const occurrences = source.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`SDT-G53 ${mutant.id} anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return source.replace(mutant.from, mutant.to);
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function focusedOracle() {
  return run("npm", [
    "exec", "--", "vitest", "run", "--config", "vitest.config.ts",
    "test/g44-global-completeness.spec.ts", "--testNamePattern", oracle,
  ], "G53 scoped Queue-to-D1 oracle");
}

function main() {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  if (process.argv.includes("--self-test")) {
    mutate(original);
    process.stdout.write(`${JSON.stringify({ result: "g53-downstream-scope-mutation-anchor-unique" })}\n`);
    return;
  }
  try {
    requirePass(build());
    requirePass(focusedOracle());
    writeFileSync(path, mutate(original), "utf8");
    requirePass(build());
    requireRed(focusedOracle());
    writeFileSync(path, original, "utf8");
    requirePass(build());
  } finally {
    writeFileSync(path, original, "utf8");
    requirePass(build());
  }
  process.stdout.write(`${JSON.stringify({ result: "g53-downstream-old-name-mutant-red", mutant: mutant.id })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

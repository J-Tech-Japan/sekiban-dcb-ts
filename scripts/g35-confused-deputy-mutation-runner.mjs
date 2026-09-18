#!/usr/bin/env node
/**
 * SDT-G35 executes the outbox-drain body-authority mutant against the focused
 * confused-deputy fixture. Source is always restored before exit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/downstream/OutboxDrain.ts";

const mutants = Object.freeze([
  Object.freeze({
    id: "drain-body-authority",
    from: "results.push(await drainTagOutbox({ serviceId: authority, tag }, env, systemPipelineClock, options));",
    to: "results.push(await drainTagOutbox({ serviceId: requestedServiceId, tag }, env, systemPipelineClock, options));",
    oracle: "rejects outbox-drain body serviceId that is not caller authority",
    // Removing only the addressing line is insufficient — also drop the mismatch gate.
    alsoFrom: "if (requestedServiceId !== authority) {",
    alsoTo: "if (false && requestedServiceId !== authority) {",
  }),
]);

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

function requireRed(result, mutant) {
  if (result.status !== 0) return;
  throw new Error(`SDT-G35 ${mutant.id} mutant was vacuous: its confused-deputy fixture remained green`);
}

function mutate(source, mutant) {
  let next = source;
  for (const [from, to] of [
    [mutant.from, mutant.to],
    [mutant.alsoFrom, mutant.alsoTo],
  ]) {
    const occurrences = next.split(from).length - 1;
    if (occurrences !== 1) {
      throw new Error(`SDT-G35 ${mutant.id} anchor expected once for ${JSON.stringify(from)}, found ${occurrences}`);
    }
    next = next.replace(from, to);
  }
  return next;
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle(pattern) {
  return run("npm", [
    "exec", "--", "vitest", "run", "--config", "vitest.config.ts",
    "test/g35-do-scope.spec.ts", "--testNamePattern", pattern,
  ], `G35 ${pattern} oracle`);
}

function main() {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  if (process.argv.includes("--self-test")) {
    for (const mutant of mutants) mutate(original, mutant);
    process.stdout.write(`${JSON.stringify({ result: "g35-confused-deputy-mutation-anchors-unique" })}\n`);
    return;
  }
  try {
    requirePass(build());
    for (const mutant of mutants) {
      requirePass(oracle(mutant.oracle));
      writeFileSync(path, mutate(original, mutant), "utf8");
      requirePass(build());
      requireRed(oracle(mutant.oracle), mutant);
      writeFileSync(path, original, "utf8");
      requirePass(build());
    }
  } finally {
    writeFileSync(path, original, "utf8");
    requirePass(build());
  }
  process.stdout.write(`${JSON.stringify({
    result: "g35-confused-deputy-mutants-red",
    mutants: mutants.map((mutant) => mutant.id),
  })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

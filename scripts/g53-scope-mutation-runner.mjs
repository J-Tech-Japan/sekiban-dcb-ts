#!/usr/bin/env node
/**
 * SDT-G53 executes the two control-route omission mutants against the real
 * focused fixtures. The source is always restored and rebuilt before exit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/scope/ControlRouteScope.ts";

const mutants = Object.freeze([
  Object.freeze({
    id: "comparison-removed",
    from: "if (input.pathServiceId !== actual) {",
    to: "if (false) {",
    oracle: "rejects a control-route service mismatch before a Durable Object call",
  }),
  Object.freeze({
    id: "identity-missing-pass-through",
    from: "return { response: scopeIdentityMissingResponse() };",
    to: "return { serviceId: input.pathServiceId };",
    oracle: "returns scope.identity_missing without deriving a control-route identity",
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
  throw new Error(`SDT-G53 ${mutant.id} mutant was vacuous: its control-route fixture remained green`);
}

function mutate(source, mutant) {
  const occurrences = source.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`SDT-G53 ${mutant.id} anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return source.replace(mutant.from, mutant.to);
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle(pattern) {
  return run("npm", [
    "exec", "--", "vitest", "run", "--config", "vitest.config.ts",
    "test/g53-scope-identity.spec.ts", "--testNamePattern", pattern,
  ], `G53 ${pattern} oracle`);
}

function main() {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  if (process.argv.includes("--self-test")) {
    for (const mutant of mutants) mutate(original, mutant);
    process.stdout.write(`${JSON.stringify({ result: "g53-control-mutation-anchors-unique" })}\n`);
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
  process.stdout.write(`${JSON.stringify({ result: "g53-control-route-mutants-red", mutants: mutants.map((mutant) => mutant.id) })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

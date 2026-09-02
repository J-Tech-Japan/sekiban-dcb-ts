#!/usr/bin/env node
/**
 * SDT-G54 C-12 omission mutant. This mutates the shipped V1 required-member
 * and present-but-undefined guards, rebuilds, and requires the fake-namespace
 * boundary fixtures to turn red. It restores the historical `?? []`
 * fail-open only in the mutant.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/commit/CommitWorker.ts";

export const G54_ENVELOPE_MUTATION = Object.freeze({
  id: "required-v1-arrays-omitted",
  replacements: Object.freeze([
    Object.freeze({
      from: "if (missingV1ArrayMembers.length > 0 || clientModelAliasMembers.length > 0) {",
      to: "if (false) {",
    }),
    Object.freeze({ from: "if (value.eventCandidates === undefined) {", to: "if (false) {" }),
    Object.freeze({ from: "if (value.consistencyTags === undefined) {", to: "if (false) {" }),
  ]),
  oracle: "rejects .* before every Durable Object call",
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
  throw new Error("SDT-G54 required V1 member omission mutant was vacuous: the zero-DO-call oracle remained green");
}

function replaceExactly(original) {
  let mutated = original;
  for (const replacement of G54_ENVELOPE_MUTATION.replacements) {
    const occurrences = mutated.split(replacement.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(`SDT-G54 mutation anchor expected once in ${sourceFile}, found ${occurrences}`);
    }
    mutated = mutated.replace(replacement.from, replacement.to);
  }
  return mutated;
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle() {
  return run("npm", [
    "exec",
    "--",
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    "test/g54-envelope-boundary.spec.ts",
    "--testNamePattern",
    G54_ENVELOPE_MUTATION.oracle,
  ], "G54 required-member zero-DO-call oracle");
}

function main() {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) {
    replaceExactly(original);
    process.stdout.write(`${JSON.stringify({ result: "anchor-unique", mutation: G54_ENVELOPE_MUTATION.id })}\n`);
    return;
  }

  try {
    requirePass(build());
    requirePass(oracle());
    writeFileSync(sourcePath, replaceExactly(original), "utf8");
    requirePass(build());
    requireRed(oracle());
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(build());
  }
  process.stdout.write(`${JSON.stringify({ result: "production-omission-mutant-red", mutation: G54_ENVELOPE_MUTATION.id })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

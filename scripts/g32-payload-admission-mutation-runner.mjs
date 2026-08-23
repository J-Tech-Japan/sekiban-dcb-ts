#!/usr/bin/env node
/**
 * G32 AC4 mutation attribution. Each entry changes the shipped CommitWorker,
 * rebuilds it, and requires precisely its admission fixture to turn red while
 * an unrelated boundary remains green. This prevents a later Durable Object
 * failure from hiding a removed admission gate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/commit/CommitWorker.ts";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const PAYLOAD_ADMISSION_MUTATIONS = Object.freeze([
  {
    id: "fatal-utf8",
    from: 'new TextDecoder("utf-8", { fatal: true }).decode(bytes)',
    to: 'new TextDecoder("utf-8").decode(bytes)',
    target: "rejects non-UTF-8",
    unrelated: "rejects JSON syntax",
  },
  {
    id: "json-syntax",
    from: "return Object.freeze({ text, parsed: JSON.parse(text) });",
    to: "return Object.freeze({ text, parsed: {} });",
    target: "rejects JSON syntax",
    unrelated: "rejects non-UTF-8",
  },
  {
    id: "root-exact-members",
    from: "assertExactMemberPaths(decoded.parsed, registered);",
    to: "void registered;",
    target: "rejects an array root",
    unrelated: "rejects non-UTF-8",
  },
  {
    id: "nested-exact-members",
    from: "assertExactMemberPaths(decoded.parsed, registered);",
    to: "void registered;",
    target: "rejects an unregistered nested member",
    unrelated: "rejects non-UTF-8",
  },
  {
    id: "array-exact-members",
    from: "assertExactMemberPaths(decoded.parsed, registered);",
    to: "void registered;",
    target: "rejects a case-mismatched object inside an array",
    unrelated: "rejects non-UTF-8",
  },
  {
    id: "additional-exact-members",
    from: "assertExactMemberPaths(decoded.parsed, registered);",
    to: "void registered;",
    target: "rejects an additional top-level property",
    unrelated: "rejects non-UTF-8",
  },
  {
    id: "case-only-exact-members",
    from: "assertExactMemberPaths(decoded.parsed, registered);",
    to: "void registered;",
    target: "rejects a case-only duplicate key",
    unrelated: "rejects non-UTF-8",
  },
  {
    id: "parse-reserialize",
    from: "payload = decoded.text;",
    to: "payload = JSON.stringify(decoded.parsed);",
    target: "preserves admitted UTF-8 JSON bytes",
    unrelated: "rejects non-UTF-8",
  },
]);

function command(program, args, label) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function mustPass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function mustRed(result, mutation) {
  if (result.status !== 0) return;
  throw new Error(`G32 payload mutation ${mutation.id} was vacuous: ${mutation.target} remained green`);
}

function runFixture(pattern) {
  return command(process.execPath, [
    vitest,
    "run", "--config", "vitest.config.ts", "test/g32-payload-admission.spec.ts",
    "--testNamePattern", pattern,
  ], `payload fixture ${pattern}`);
}

function rebuild() {
  return command("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function replaceExactly(original, mutation) {
  const count = original.split(mutation.from).length - 1;
  if (count !== 1) throw new Error(`payload mutation ${mutation.id} expected one source anchor, received ${count}`);
  return original.replace(mutation.from, mutation.to);
}

function verifyMatrix() {
  const ids = PAYLOAD_ADMISSION_MUTATIONS.map((mutation) => mutation.id);
  if (new Set(ids).size !== ids.length) throw new Error("payload mutation IDs must be unique");
  for (const mutation of PAYLOAD_ADMISSION_MUTATIONS) {
    if (mutation.target === mutation.unrelated) throw new Error(`payload mutation ${mutation.id} lacks an unrelated fixture`);
  }
}

function execute(mutation) {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  try {
    mustPass(runFixture(mutation.target));
    writeFileSync(path, replaceExactly(original, mutation), "utf8");
    mustPass(rebuild());
    mustRed(runFixture(mutation.target), mutation);
    mustPass(runFixture(mutation.unrelated));
  } finally {
    writeFileSync(path, original, "utf8");
    mustPass(rebuild());
  }
  return Object.freeze({ id: mutation.id, target: mutation.target, unrelated: mutation.unrelated, result: "red-with-unrelated-green" });
}

function main() {
  verifyMatrix();
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ mutations: PAYLOAD_ADMISSION_MUTATIONS.map((mutation) => mutation.id), selfTest: "matrix-valid" })}\n`);
    return;
  }
  mustPass(rebuild());
  const results = PAYLOAD_ADMISSION_MUTATIONS.map(execute);
  process.stdout.write(`${JSON.stringify({ result: "all-admission-mutants-red", mutations: results })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

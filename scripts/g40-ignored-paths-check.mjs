#!/usr/bin/env node
/**
 * Guard the small documentation paths ignored by G84's PR workflow.
 *
 * This is intentionally conservative: a broad docs, test, or scripts glob
 * ignore is rejected, and any exact ignored file referenced by test/, scripts/
 * or packages/ is rejected. Adding a new consumer therefore turns this guard
 * red before the path can disappear from CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MANIFEST = "ci/lanes.json";

function fail(message) {
  throw new Error(`g40-ignored-paths-check:${message}`);
}

function globToRegex(pattern) {
  let value = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      value += ".*";
      index += 1;
    } else if (character === "*") value += "[^/]*";
    else value += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${value}$`);
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch (error) {
    fail(`could not enumerate tracked files: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSafePatterns(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) fail("pathsIgnore must contain at least one path");
  const files = trackedFiles();
  const reads = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) fail("ignored paths must be non-empty strings");
    if (pattern === "docs/**" || pattern === "docs/*" || pattern === "test/**" || pattern === "scripts/**" || pattern === "**") fail(`broad ignored path is forbidden: ${pattern}`);
    const matches = files.filter((file) => globToRegex(pattern).test(file));
    if (matches.length === 0 && !pattern.includes("*")) matches.push(pattern);
    for (const file of matches) {
      let output = "";
      try {
        output = execFileSync("rg", ["-n", "--fixed-strings", "--glob", "!scripts/g40-ignored-paths-check.mjs", file, "test", "scripts", "packages"], { encoding: "utf8" });
      } catch (error) {
        if (error.status === 1) output = "";
        else fail(`scan failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (output.trim().length > 0) reads.push({ file, references: output.trim().split("\n") });
    }
  }
  if (reads.length > 0) fail(`ignored path is read by test/scripts/packages: ${JSON.stringify(reads)}`);
  return { patterns, scannedFiles: files.filter((file) => patterns.some((pattern) => globToRegex(pattern).test(file))) };
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (process.argv.includes("--self-test")) {
    assertSafePatterns(["docs/SDT-G84-evidence.md"]);
    let rejected = false;
    try { assertSafePatterns(["docs/**"]); } catch { rejected = true; }
    if (!rejected) fail("self-test accepted a broad docs glob");
    process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ignored-paths-self-test/v1", broadGlobRejected: true }, null, 2)}\n`);
    return;
  }
  const result = assertSafePatterns(manifest.pathsIgnore);
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ignored-paths/v1", ...result }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

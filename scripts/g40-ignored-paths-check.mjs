#!/usr/bin/env node
/**
 * Guard the manifest's optional ignored paths. A current graph may have no
 * ignored paths; when it has any, broad ignores and exact files read by
 * repository checks remain forbidden.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MANIFEST = "ci/lanes.json";
const BROAD_PATTERNS = new Set(["docs/**", "docs/*", "test/**", "test/*", "scripts/**", "scripts/*", "packages/**", "packages/*", "**"]);

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
    else if (character === "?") value += "[^/]";
    else value += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${value}$`);
}

function trackedFiles(root = process.cwd()) {
  try {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch (error) {
    fail(`could not enumerate tracked files: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trackedReferences(file, root = process.cwd()) {
  try {
    return execFileSync(
      "git",
      ["grep", "-n", "--fixed-strings", "--", file, "test", "scripts", "packages", ":(exclude)scripts/g40-ignored-paths-check.mjs"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    if (error.status === 1) return "";
    fail(`scan failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function syntheticReferences(file, references) {
  if (references instanceof Map) return references.get(file) ?? "";
  if (references !== undefined && typeof references === "object") return references[file] ?? "";
  return null;
}

export function assertSafePatterns(patterns, { root = process.cwd(), files = trackedFiles(root), references = undefined } = {}) {
  if (!Array.isArray(patterns)) fail("pathsIgnore must be an array");
  const reads = [];
  const scanned = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) fail("ignored paths must be non-empty strings");
    if (BROAD_PATTERNS.has(pattern)) fail(`broad ignored path is forbidden: ${pattern}`);
    const matcher = globToRegex(pattern);
    const matches = files.filter((file) => matcher.test(file));
    const candidates = matches.length === 0 && !pattern.includes("*") && !pattern.includes("?") ? [pattern] : matches;
    scanned.push(...matches);
    for (const file of candidates) {
      const output = syntheticReferences(file, references);
      const found = output === null ? trackedReferences(file, root) : output;
      if (String(found).trim().length > 0) reads.push({ file, references: String(found).trim().split("\n") });
    }
  }
  if (reads.length > 0) fail(`ignored path is read by test/scripts/packages: ${JSON.stringify(reads)}`);
  return { patterns, scannedFiles: [...new Set(scanned)] };
}

function expectRejected(action, label, expectedMessage) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) fail(`self-test ${label} reported the wrong rejection: ${message}`);
    return { label, rejected: true, code: expectedMessage };
  }
  fail(`self-test accepted ${label}`);
}

function runSelfTest() {
  const files = ["docs/neutral-self-test.md", "scripts/consumer.mjs"];
  const references = new Map([["docs/neutral-self-test.md", "scripts/consumer.mjs:1: docs/neutral-self-test.md"]]);
  const empty = assertSafePatterns([], { files, references });
  const broad = expectRejected(() => assertSafePatterns(["docs/**"], { files, references }), "a broad docs glob", "broad ignored path is forbidden");
  const exact = expectRejected(() => assertSafePatterns(["docs/neutral-self-test.md"], { files, references }), "an exact referenced file", "ignored path is read by test/scripts/packages");
  return {
    schema: "sdt-g40-ignored-paths-self-test/v2",
    emptyPathsPass: empty.scannedFiles.length === 0,
    broad,
    exact,
  };
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
    return;
  }
  const result = assertSafePatterns(manifest.pathsIgnore);
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ignored-paths/v2", ...result }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

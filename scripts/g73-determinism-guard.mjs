#!/usr/bin/env node
/**
 * Keep driver-reported timing out of semantic equality assertions.
 *
 * The public response may still carry a duration field and wire-shape tests
 * may still assert that the field exists.  This guard only rejects assertions
 * that compare a driver field's value as part of a deep/equality assertion.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const testRoot = resolve(root, "test");
const assertionMethods = ["toEqual", "toStrictEqual", "toBe"];
const g22SnapshotFile = "test/g22-bootstrap-d1.spec.ts";
const driverFields = [
  "duration",
  "timings",
  "total_attempts",
  "served_by_region",
  "served_by_colo",
  "served_by_primary",
];

function collectTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(path));
    else if ([".ts", ".tsx", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function assertionArgumentEnd(source, openIndex) {
  let depth = 1;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unclosed equality assertion while scanning driver-timing guard");
}

function driverFieldInEquality(argument) {
  const normalized = argument.replace(/\\"/g, '"').replace(/\\'/g, "'");
  for (const field of driverFields) {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const property = new RegExp(`(?:["']?${escapedField}["']?\\s*:)`);
    const shorthand = new RegExp("(?:[,{]\\s*)" + escapedField + "\\s*(?=[,}])");
    if (property.test(argument) || property.test(normalized) || shorthand.test(argument) || shorthand.test(normalized)) return field;
  }
  return undefined;
}

function rawG22SnapshotViolation(source, file) {
  if (file !== g22SnapshotFile) return [];
  if (!/expect\(\s*await\s+snapshot\(\)\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*before\s*\)/.test(source)) return [];
  const snapshot = /const snapshot = async \(\) => \(\{([\s\S]*?)\n\s*\}\);/.exec(source);
  if (snapshot === null) return [];
  // G22's snapshot is the explicit normalization boundary for raw D1
  // metadata. A direct driver result in diagnosticAttempts must stay inside
  // semanticD1Result before the whole snapshot is compared.
  const rawDriverResult = /diagnosticAttempts\s*:\s*(?!semanticD1Result\s*\()([\s\S]*?)\.(?:all|first|raw)\s*(?:<[^>]*>)?\s*\(/.exec(snapshot[1]);
  if (rawDriverResult === null) return [];
  const bodyStart = source.indexOf(snapshot[1], snapshot.index);
  return [{
    file,
    line: source.slice(0, bodyStart + rawDriverResult.index).split("\n").length,
    method: "snapshot-normalization-boundary",
    field: "raw-d1-result",
    kind: "raw-d1-snapshot-without-semantic-normalization",
  }];
}

function scanSource(source, file) {
  const violations = [];
  let assertionsScanned = 0;
  const methodPattern = new RegExp(`\\.(?:${assertionMethods.join("|")})\\s*\\(`, "g");
  for (let match = methodPattern.exec(source); match !== null; match = methodPattern.exec(source)) {
    const openIndex = source.indexOf("(", match.index);
    const closeIndex = assertionArgumentEnd(source, openIndex);
    assertionsScanned += 1;
    const argument = source.slice(openIndex + 1, closeIndex);
    const field = driverFieldInEquality(argument);
    if (field === undefined) continue;
    violations.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      method: match[0].slice(1).replace(/\s*\($/, ""),
      field,
    });
  }
  const snapshotViolations = rawG22SnapshotViolation(source, file);
  return {
    assertionsScanned,
    violations: [...violations, ...snapshotViolations],
    normalizationChecks: file === g22SnapshotFile ? 1 : 0,
  };
}

function assertNoDriverTimingEquality(files) {
  const violations = [];
  let assertionsScanned = 0;
  let normalizationChecks = 0;
  for (const file of files) {
    const result = scanSource(readFileSync(file, "utf8"), relative(root, file));
    assertionsScanned += result.assertionsScanned;
    normalizationChecks += result.normalizationChecks;
    violations.push(...result.violations);
  }
  if (violations.length > 0) {
    throw new Error(`Driver-timing equality assertion(s) found:\n${JSON.stringify(violations, null, 2)}`);
  }
  return { assertionsScanned, normalizationChecks, violations };
}

function selfTest() {
  const red = scanSource('expect(value).toEqual({ duration: "PT0S" });', "synthetic.ts");
  if (red.violations.length !== 1 || red.violations[0].field !== "duration") {
    throw new Error("G73 guard self-test failed to reject a duration deep-equality assertion");
  }
  const shorthandRed = scanSource("expect(value).toEqual({ duration });", "synthetic-shorthand.ts");
  if (shorthandRed.violations.length !== 1 || shorthandRed.violations[0].field !== "duration") {
    throw new Error("G73 guard self-test failed to reject a shorthand duration equality assertion");
  }
  const indirectShorthandRed = scanSource("expect(JSON.stringify(value)).toBe(JSON.stringify({ duration }));", "synthetic-indirect-shorthand.ts");
  if (indirectShorthandRed.violations.length !== 1 || indirectShorthandRed.violations[0].field !== "duration") {
    throw new Error("G73 guard self-test failed to reject an indirect shorthand duration equality assertion");
  }
  const escapedRed = scanSource('expect(JSON.stringify(value)).toBe("{\\"duration\\":\\"PT0S\\"}");', "synthetic-json.ts");
  if (escapedRed.violations.length !== 1 || escapedRed.violations[0].field !== "duration") {
    throw new Error("G73 guard self-test failed to reject a serialized duration equality assertion");
  }
  const publicShape = scanSource('expect(keys).toEqual(["duration", "writtenEvents"]);', "synthetic-shape.ts");
  if (publicShape.violations.length !== 0) {
    throw new Error("G73 guard self-test incorrectly rejected a public wire-shape key assertion");
  }
  const rawG22 = [
    "const snapshot = async () => ({",
    "  diagnosticAttempts: (await database().prepare(\"SELECT duration FROM attempts\").all()),",
    "});",
    "const before = await snapshot();",
    "expect(await snapshot()).toEqual(before);",
  ].join("\n");
  const rawG22Result = scanSource(rawG22, g22SnapshotFile);
  if (!rawG22Result.violations.some(({ kind }) => kind === "raw-d1-snapshot-without-semantic-normalization")) {
    throw new Error("G73 guard self-test failed to reject the raw G22 snapshot regression");
  }
  process.stdout.write(`${JSON.stringify({ guard: "driver-timing-equality", selfTest: "passed" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const files = collectTestFiles(testRoot);
  const result = assertNoDriverTimingEquality(files);
  process.stdout.write(`${JSON.stringify({
    guard: "driver-timing-equality",
    filesScanned: files.length,
    assertionsScanned: result.assertionsScanned,
    normalizationChecks: result.normalizationChecks,
    knownFields: driverFields,
    violations: result.violations,
  })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

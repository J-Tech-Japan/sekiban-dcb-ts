#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const fixture = JSON.parse(readFileSync(resolve(root, "fixtures/suid-allocator-golden.json"), "utf8"));
const coverage = readFileSync(resolve(root, "test/g32-suid-coverage.spec.ts"), "utf8");
const parity = readFileSync(resolve(root, "test/g32-parity.spec.ts"), "utf8");

if (process.env.SDT_G32_SUID_COVERAGE_FORCE_FAILURE === "1") {
  throw new Error("SDT-G32 SUID coverage forced failure");
}
if (!Array.isArray(fixture.requiredRowIds) || fixture.requiredRowIds.length === 0) {
  throw new Error("G32 allocator fixture requiredRowIds is invalid");
}
const covered = [...coverage.matchAll(/rowId:\s*"(M(?:1[0-2]|[1-9]|2[ab]))"/g)].map((match) => match[1]);
const expected = [...fixture.requiredRowIds].sort();
const actual = [...new Set(covered)].sort();
if (covered.length !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`G32 SUID coverage row set mismatch: expected ${expected.join(",")}, received ${actual.join(",")}`);
}
for (const rowId of expected) {
  if (!new RegExp(`\\b${rowId}\\b`).test(parity)) {
    throw new Error(`G32 allocator parity fixture is missing implementation oracle ${rowId}`);
  }
}
console.log(JSON.stringify({ rows: actual, count: actual.length }));

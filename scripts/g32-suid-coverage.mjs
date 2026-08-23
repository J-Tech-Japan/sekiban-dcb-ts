#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUID_MUTATIONS } from "./g32-suid-mutation-runner.mjs";

const root = process.cwd();
const fixture = JSON.parse(readFileSync(resolve(root, "fixtures/suid-allocator-golden.json"), "utf8"));
const coverage = readFileSync(resolve(root, "test/g32-suid-coverage.spec.ts"), "utf8");
const rowFixtures = readFileSync(resolve(root, "test/g32-suid-rows.spec.ts"), "utf8");

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
const executableRows = [...rowFixtures.matchAll(/it\("(M(?:1[0-2]|[1-9]|2[ab]))\s/g)].map((match) => match[1]);
const executableSet = [...new Set(executableRows)].sort();
if (executableRows.length !== executableSet.length || JSON.stringify(executableSet) !== JSON.stringify(expected)) {
  throw new Error(`G32 executable row fixture set mismatch: expected ${expected.join(",")}, received ${executableSet.join(",")}`);
}
const mutationRows = SUID_MUTATIONS.map((mutation) => mutation.rowId);
const mutationSet = [...new Set(mutationRows)].sort();
if (mutationRows.length !== mutationSet.length || JSON.stringify(mutationSet) !== JSON.stringify(expected)) {
  throw new Error(`G32 production mutation row set mismatch: expected ${expected.join(",")}, received ${mutationSet.join(",")}`);
}
for (const mutation of SUID_MUTATIONS) {
  if (mutation.rowId === mutation.unrelatedRowId || !mutationSet.includes(mutation.unrelatedRowId)) {
    throw new Error(`G32 mutation ${mutation.rowId} does not prove an unrelated-row green result`);
  }
}
console.log(JSON.stringify({ rows: actual, count: actual.length, executable: executableSet, productionMutations: mutationSet }));

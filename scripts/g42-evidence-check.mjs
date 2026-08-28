#!/usr/bin/env node
/** Guards the committed, sanitized P0 evidence and required G42 doc limits. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  throw new Error(`g42-evidence:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exact(value, expected, label) {
  if (value !== expected) fail(`${label} must be ${JSON.stringify(expected)}`);
}

export function assertG42CommittedEvidence(document, audit) {
  exact(object(audit, "audit").schema, "sdt.g42.p0-audit/v1", "audit.schema");
  exact(audit.outcome, "PARTIAL", "audit.outcome");
  const cohort = object(audit.cohort, "audit.cohort");
  exact(cohort.expectedIdentityCount, 50, "audit.cohort.expectedIdentityCount");
  exact(cohort.joinedIdentityCount, 46, "audit.cohort.joinedIdentityCount");
  exact(cohort.exactJoinedIdentityCount, 0, "audit.cohort.exactJoinedIdentityCount");
  exact(cohort.unknownIdentityCount, 4, "audit.cohort.unknownIdentityCount");
  if (!Array.isArray(audit.unknowns) || audit.unknowns.length !== 4 || audit.unknowns.some((row) => row.stage !== "journal-handler-absent")) {
    fail("audit must preserve the four handler-absent UNKNOWN identities");
  }
  if (typeof document !== "string" || document.includes("Bearer ")) fail("evidence document must not carry a bearer token");
  for (const heading of [
    "## Scope and advisory boundary",
    "## P0: existing G37 A-5 cohort, read-only",
    "## P1 topology and treatment protocol",
    "## Pre-run decision and reproducibility procedure",
    "## Deploy/read-back and P1 result",
    "## Non-regression checks",
    "PARTIAL",
    "D is a **storage-layout screen only**",
    "ADVISORY",
  ]) {
    if (!document.includes(heading)) fail(`evidence document lacks ${heading}`);
  }
  return Object.freeze({ outcome: audit.outcome, unknownIdentityCount: audit.unknowns.length });
}

export function selfTest() {
  const audit = {
    schema: "sdt.g42.p0-audit/v1",
    outcome: "PARTIAL",
    cohort: { expectedIdentityCount: 50, joinedIdentityCount: 46, exactJoinedIdentityCount: 0, unknownIdentityCount: 4 },
    unknowns: Array.from({ length: 4 }, () => ({ stage: "journal-handler-absent" })),
  };
  const document = [
    "## Scope and advisory boundary", "## P0: existing G37 A-5 cohort, read-only", "## P1 topology and treatment protocol",
    "## Pre-run decision and reproducibility procedure", "## Deploy/read-back and P1 result", "## Non-regression checks",
    "PARTIAL", "D is a **storage-layout screen only**", "ADVISORY",
  ].join("\n");
  const accepted = assertG42CommittedEvidence(document, audit);
  let forcedRed = false;
  try { assertG42CommittedEvidence(document.replace("ADVISORY", ""), audit); } catch { forcedRed = true; }
  if (!forcedRed) fail("advisory-boundary deletion unexpectedly passed");
  return Object.freeze({ accepted, forcedRed: "advisory-boundary" });
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const document = readFileSync("docs/SDT-G42-journal-first-touch-evidence.md", "utf8");
  const audit = JSON.parse(readFileSync("docs/evidence/SDT-G42-p0-audit.json", "utf8"));
  console.log(JSON.stringify(assertG42CommittedEvidence(document, audit), null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) main();

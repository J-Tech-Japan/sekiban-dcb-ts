#!/usr/bin/env node
/**
 * SDT-G79 AC3 proof mutations for the G43 backlog fixture.
 *
 * The first mutation removes the tail obligation and runs the real focused
 * Vitest oracle.  The second removes only the proof's re-arm assertion and
 * runs the source-shape contract that protects the stated test boundary.  A
 * green result for either mutation is therefore a failed proof, not an
 * acceptable alternative implementation.  The tracked test is restored in
 * every path.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "test/g43-tag-sql.spec.ts";
const sourcePath = resolve(root, sourceFile);
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const oracleTitle = "AC6: a backlog larger than one alarm budget progresses and re-arms instead of starving its tail";
const loopAnchor = "for (let ordinal = 1; ordinal <= 33; ordinal += 1)";
const limitAnchor = 'post(value, "/outbox/pending", { nowMs: Date.now(), limit: 32 })';
const firstRearmAssertion = "expect(await configuredAlarm(value)).not.toBeNull();";
const finalAlarmAssertion = "expect(await configuredAlarm(value)).toBeNull();";

function runOracle(label) {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    sourceFile,
    "--testNamePattern", oracleTitle,
    "--reporter=verbose",
  ], {
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
  throw new Error(`SDT-G79 ${mutant} mutant was green; the AC6 backlog oracle is vacuous`);
}

function backlogBlock(source) {
  const start = source.indexOf(`  it("${oracleTitle}`);
  const end = source.indexOf('  it("AC7:', start + 1);
  if (start < 0 || end < 0) throw new Error("SDT-G79 AC6 backlog test block was not found");
  return source.slice(start, end);
}

function assertProofShape(source) {
  const block = backlogBlock(source);
  const required = [
    loopAnchor,
    limitAnchor,
    "expect(new Set(sent)).toHaveLength(32);",
    firstRearmAssertion,
    "expect(new Set(sent)).toHaveLength(33);",
    finalAlarmAssertion,
  ];
  const missing = required.filter((anchor) => !block.includes(anchor));
  if (missing.length > 0) {
    throw new Error(`SDT-G79 AC6 proof contract missing: ${missing.join(" | ")}`);
  }
  if ((block.match(new RegExp(loopAnchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length !== 1) {
    throw new Error("SDT-G79 AC6 backlog loop must remain exactly once");
  }
}

function mutateShrinkBacklog(source) {
  if (source.split(loopAnchor).length - 1 !== 1) {
    throw new Error("SDT-G79 backlog-size mutation anchor expected once");
  }
  return source.replace(loopAnchor, "for (let ordinal = 1; ordinal <= 32; ordinal += 1)");
}

function mutateRemoveRearmAssertion(source) {
  if (source.split(firstRearmAssertion).length - 1 !== 1) {
    throw new Error("SDT-G79 re-arm assertion mutation anchor expected once");
  }
  return source.replace(firstRearmAssertion, "// G79 mutant: re-arm assertion removed");
}

function expectContractRed(source) {
  let red = false;
  try {
    assertProofShape(source);
  } catch {
    red = true;
  }
  if (!red) throw new Error("SDT-G79 re-arm-assertion mutant was green; the proof contract is vacuous");
}

function selfTest() {
  const source = readFileSync(sourcePath, "utf8");
  assertProofShape(source);
  const shrunk = mutateShrinkBacklog(source);
  if (shrunk.includes(loopAnchor)) throw new Error("SDT-G79 shrink mutant did not change the backlog");
  expectContractRed(mutateRemoveRearmAssertion(source));
  if (source.includes("setTimeout(resolve") || source.includes("process.hrtime")) {
    throw new Error("SDT-G79 proof unexpectedly uses a timer or process clock");
  }
  console.log(JSON.stringify({
    sourceFile,
    oracleTitle,
    backlog: 33,
    alarmLimit: 32,
    mutations: ["shrink-backlog-below-alarm-budget", "remove-rearm-assertion"],
    selfTest: "anchors-unique-and-proof-contract-valid",
  }));
}

function main() {
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    assertProofShape(original);
    requirePass(runOracle("SDT-G79 AC6 healthy backlog oracle"));

    writeFileSync(sourcePath, mutateShrinkBacklog(original), "utf8");
    const shrink = runOracle("SDT-G79 shrink-backlog mutant");
    requireRed(shrink, "shrink-backlog");
    writeFileSync(sourcePath, original, "utf8");

    writeFileSync(sourcePath, mutateRemoveRearmAssertion(original), "utf8");
    expectContractRed(readFileSync(sourcePath, "utf8"));
    writeFileSync(sourcePath, original, "utf8");

    console.log(JSON.stringify({
      result: "both-red",
      rows: [
        { mutant: "shrink-backlog-below-alarm-budget", oracle: "focused Vitest AC6 runtime", result: "red" },
        { mutant: "remove-rearm-assertion", oracle: "AC6 proof-shape contract", result: "red" },
      ],
    }));
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

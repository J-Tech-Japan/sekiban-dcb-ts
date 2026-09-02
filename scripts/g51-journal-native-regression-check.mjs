#!/usr/bin/env node
/**
 * SDT-G51's local regression locator. It deliberately inspects immutable Git
 * revisions rather than treating a deployed trace as proof of source history.
 * G41 removed the normal CommitWorker -> Journal route; that route was the
 * only path that reached JournalDurableObject.traceCommitActor(), which in
 * turn entered the S16-native `actor.handle` callback.
 */
import { execFileSync } from "node:child_process";

const COMMIT_WORKER = "packages/dcb-runtime/src/commit/CommitWorker.ts";
const JOURNAL = "packages/dcb-runtime/src/journal/JournalDurableObject.ts";
const BASELINE = "c2dd342";
const CURRENT_MAIN = "origin/main";
const BISECT_WINDOW = Object.freeze([
  "53f14f5",
  "beb71a3",
  "0af4d0e",
  "7cc38a4",
  "3707688",
  "b82f0d2",
]);

function fail(message) {
  throw new Error(`g51-journal-native-regression-check:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sourceAt(reference, path) {
  try {
    return execFileSync("git", ["show", `${reference}:${path}`], { encoding: "utf8" });
  } catch {
    fail(`cannot read ${path} at ${reference}`);
  }
}

export function inspectNativeJournalHandoff(commitWorker, journal) {
  const commitWorkerCallsJournal = [
    "const journal = this.journalFor(attemptId);",
    'this.postJson<JournalRecord>(journal, "/admit"',
    "private journalFor(attemptId: string)",
    "private async transition(",
  ].every((needle) => commitWorker.includes(needle));
  const journalEntersActorSpan = [
    "private readonly nativeTracing: NativeTracing",
    "return enterNativeActorHandleSpan(",
    "private async traceCommitActor(",
  ].every((needle) => journal.includes(needle));
  return Object.freeze({
    commitWorkerCallsJournal,
    journalEntersActorSpan,
    reachesNativeActorSpan: commitWorkerCallsJournal && journalEntersActorSpan,
  });
}

function inspect(reference) {
  return Object.freeze({
    reference,
    ...inspectNativeJournalHandoff(sourceAt(reference, COMMIT_WORKER), sourceAt(reference, JOURNAL)),
  });
}

function assertRegression(reference, expectedPresent) {
  const result = inspect(reference);
  if (result.reachesNativeActorSpan !== expectedPresent) {
    const state = expectedPresent ? "present" : "absent";
    fail(`${reference} expected normal Journal -> native actor handoff ${state}`);
  }
  return result;
}

function selfTest() {
  const baseline = inspectNativeJournalHandoff(
    'const journal = this.journalFor(attemptId);\nthis.postJson<JournalRecord>(journal, "/admit"\nprivate journalFor(attemptId: string) {}\nprivate async transition() {}',
    "private readonly nativeTracing: NativeTracing\nprivate async traceCommitActor() {}\nreturn enterNativeActorHandleSpan(",
  );
  const removed = inspectNativeJournalHandoff("private async retiredJournalMilestone() {}", baseline.journalEntersActorSpan
    ? "private readonly nativeTracing: NativeTracing\nprivate async traceCommitActor() {}\nreturn enterNativeActorHandleSpan("
    : "");
  if (!baseline.reachesNativeActorSpan || removed.reachesNativeActorSpan) fail("fixture classification drifted");
  return Object.freeze({ baseline, removed });
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ selfTest: selfTest(), result: "g51-regression-check-self-test-passed" })}\n`);
    return;
  }
  if (process.argv.includes("--bisect")) {
    const results = [BASELINE, ...BISECT_WINDOW, CURRENT_MAIN].map(inspect);
    const baseline = results.find((result) => result.reference === BASELINE);
    const current = results.find((result) => result.reference === CURRENT_MAIN);
    if (baseline?.reachesNativeActorSpan !== true) fail(`${BASELINE} must retain the native Journal handoff`);
    if (current?.reachesNativeActorSpan !== false) fail(`${CURRENT_MAIN} must expose the regression before the G51 repair`);
    process.stdout.write(`${JSON.stringify({
      mechanism: "G41 removed CommitWorker's normal Journal admission/transition route, so JournalDurableObject.traceCommitActor no longer reaches enterNativeActorHandleSpan (S16 actor.handle).",
      results,
    }, null, 2)}\n`);
    return;
  }
  const reference = argument("--ref", CURRENT_MAIN);
  const expectedPresent = !process.argv.includes("--expect-absent");
  const result = assertRegression(reference, expectedPresent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();

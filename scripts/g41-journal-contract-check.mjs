#!/usr/bin/env node
/**
 * SDT-G41 closes the old attempt-level Journal from the normal commit path.
 * This guard deliberately reads the runtime route table and the committed
 * duty inventory independently: changing either one cannot silently turn a
 * retired Journal responsibility back into an implicit CommitWorker call.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const ROUTES = Object.freeze([
  "POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*",
  "GET /state",
  "GET /result",
  "GET /repair/workset",
  "GET /repair/observations",
  "POST /admit",
  "POST /transition",
  "POST /reconcile",
  "POST /reservation-failure",
  "POST /takeover",
  "POST /fault",
  "POST /repair/observation",
  "POST /debug/alarm",
]);
// These are sealed independently from the JSON inventory.  The route table
// has a runtime source of truth; durable field and caller universes do not, so
// the pre-change inventory is their deliberately explicit authority.
const DURABLE_FIELD_UNIVERSE = Object.freeze([
  "__sdt_g42_p1_alarm",
  "__sdt_g42_p1_index",
  "__sdt_g42_p1_record__:*",
  "journal",
  "journal.alarm",
  "journal.allocatorVector",
  "journal.attemptId",
  "journal.candidates",
  "journal.consistencyTags",
  "journal.failureCause",
  "journal.missingTags",
  "journal.ownerEpoch",
  "journal.repairObservations",
  "journal.state",
  "journal.terminalResponse",
  "journal.testFaults",
]);
const CALLER_UNIVERSE = Object.freeze([
  "CommitWorker.handleUntraced (pre-G41 only)",
  "JournalDurableObject.alarm (inert after commit removal)",
  "packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker",
  "packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/result",
  "packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/state",
  "packages/dcb-runtime/src/index.ts:/journals/:attemptId/result",
  "packages/dcb-runtime/src/index.ts:/journals/:attemptId/state",
  "packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate",
  "packages/dcb-runtime/src/repair/RepairWorker.ts:recordClearedObservations",
  "samples/meeting-room/src/worker.cloudflare-only.ts:handleG42JournalProbe",
  "test/journal.spec.ts direct Journal-only fault fixture",
]);
const DUTY_DURABLE_FIELDS = Object.freeze({
  "J01-g42-private-probe": ["__sdt_g42_p1_record__:*", "__sdt_g42_p1_index", "__sdt_g42_p1_alarm"],
  "J02-direct-state": ["journal"],
  "J03-direct-terminal-result": ["journal.terminalResponse"],
  "J04-repair-workset": ["journal.candidates", "journal.missingTags"],
  "J05-repair-observations": ["journal.repairObservations"],
  "J06-admit-and-attempt-idempotency": ["journal.attemptId", "journal.candidates", "journal.consistencyTags"],
  "J07-reserved-allocated-writing-complete": ["journal.state", "journal.allocatorVector", "journal.terminalResponse"],
  "J08-reservation-failure-and-cancel": ["journal.failureCause", "journal.missingTags"],
  "J09-reconcile": ["journal.state", "journal.failureCause"],
  "J10-alarm-and-takeover": ["journal.ownerEpoch", "journal.alarm"],
  "J11-debug-fault": ["journal.testFaults"],
});
const DUTY_CALLERS = Object.freeze({
  "J01-g42-private-probe": ["samples/meeting-room/src/worker.cloudflare-only.ts:handleG42JournalProbe"],
  "J02-direct-state": ["packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/state", "packages/dcb-runtime/src/index.ts:/journals/:attemptId/state"],
  "J03-direct-terminal-result": ["packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/result", "packages/dcb-runtime/src/index.ts:/journals/:attemptId/result"],
  "J04-repair-workset": ["packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate", "packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker"],
  "J05-repair-observations": ["packages/dcb-runtime/src/repair/RepairWorker.ts:recordClearedObservations", "packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker"],
  "J06-admit-and-attempt-idempotency": ["CommitWorker.handleUntraced (pre-G41 only)"],
  "J07-reserved-allocated-writing-complete": ["CommitWorker.handleUntraced (pre-G41 only)"],
  "J08-reservation-failure-and-cancel": ["CommitWorker.handleUntraced (pre-G41 only)"],
  "J09-reconcile": ["CommitWorker.handleUntraced (pre-G41 only)"],
  "J10-alarm-and-takeover": ["JournalDurableObject.alarm (inert after commit removal)"],
  "J11-debug-fault": ["test/journal.spec.ts direct Journal-only fault fixture"],
});
const VERDICTS = new Set(["MOVED", "NO_LONGER_REQUIRED", "STILL_REQUIRED"]);
const POST_G41_SURFACES = new Set([
  "LIVE_NON_COMMIT",
  "RETAINED_DIAGNOSTIC",
  "DEAD_CODE_FOLLOW_UP",
  "TEST_ONLY",
]);

function fail(message) {
  throw new Error(`G41 Journal-removal contract check failed: ${message}`);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

function requireContains(source, token, context) {
  if (!source.includes(token)) fail(`${context} is missing ${JSON.stringify(token)}`);
}

function requireAbsent(source, token, context) {
  if (source.includes(token)) fail(`${context} must not contain ${JSON.stringify(token)}`);
}

function between(source, begin, end, context) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) fail(`${context} boundaries are missing`);
  return source.slice(start, finish);
}

function parseInventory(text) {
  try {
    return JSON.parse(text);
  } catch (caught) {
    fail(`duty inventory is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

function asExactStringSet(value, context) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    fail(`${context} must be a non-empty string array`);
  }
  const result = new Set(value);
  if (result.size !== value.length) fail(`${context} contains duplicate members`);
  return result;
}

function assertSameSet(actual, expected, context) {
  if (actual.size !== expected.size || [...expected].some((member) => !actual.has(member))) {
    fail(`${context} is not an exact count/set match: ${JSON.stringify([...actual])}`);
  }
}

function assertExactStringSet(value, expectedValues, context) {
  assertSameSet(asExactStringSet(value, context), new Set(expectedValues), context);
}

/**
 * Derive the finite route universe from the handler conditionals, rather than
 * trusting the committed inventory's hand-written list.  The parser is
 * intentionally narrow: a novel conditional form is a contract failure until
 * its route is explicitly classified, instead of becoming an unobserved
 * Journal surface.
 */
function journalRouteSetFromRuntime(journal) {
  const exact = [...journal.matchAll(/request\.method === "(GET|POST)" && path === "(\/[^"\n]+)"/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  const prefix = [...journal.matchAll(/request\.method === "(GET|POST)" && path\.startsWith\(`\$\{G42_JOURNAL_PROBE_INTERNAL_PREFIX\}\/`\)/g)];
  const allExactPathChecks = journal.match(/\bpath ===/g) ?? [];
  const allPrefixPathChecks = journal.match(/\bpath\.startsWith\(/g) ?? [];
  if (allExactPathChecks.length !== exact.length || allPrefixPathChecks.length !== prefix.length) {
    fail("Journal route table used a path conditional outside the closed parser grammar");
  }
  if (prefix.length !== 1 || prefix[0]?.[1] !== "POST") {
    fail("Journal route table must have exactly the fenced G42 POST prefix route");
  }
  if (exact.length !== ROUTES.length - 1 || new Set(exact).size !== exact.length) {
    fail(`Journal route table has an unclassified or duplicate exact route conditional: ${JSON.stringify(exact)}`);
  }
  return new Set(["POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*", ...exact]);
}

function snapshot() {
  return {
    inventory: read("contracts/g41-journal-duty-inventory.json"),
    commit: read("packages/dcb-runtime/src/commit/CommitWorker.ts"),
    journal: read("packages/dcb-runtime/src/journal/JournalDurableObject.ts"),
    repair: read("packages/dcb-runtime/src/repair/RepairWorker.ts"),
    repairCli: read("packages/dcb-runtime/src/cli/OperatorRepairCli.ts"),
    probe: read("packages/dcb-runtime/src/journal/JournalFirstTouchProbe.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"),
    g42Worker: read("samples/meeting-room/src/worker.cloudflare-only.ts"),
    g38Tombstone: read("scripts/g38-tombstone-check.mjs"),
    test: read("test/g41-journal-removal.spec.ts"),
    evidence: read("docs/SDT-G41-evidence.md"),
    packageJson: read("package.json"),
    ci: read(".github/workflows/ci.yml"),
  };
}

function assertInventory(inventory, journal) {
  if (inventory?.schema !== "sdt-g41-journal-duty-inventory/v1") fail("inventory schema is not sdt-g41-journal-duty-inventory/v1");
  if (inventory.preChangeMain !== "7cc38a4") fail("inventory must record the reviewed pre-change main identity");
  if (inventory.publicCommitWire?.request !== "PRESERVED" || inventory.publicCommitWire?.response !== "PRESERVED") {
    fail("inventory must separately declare the public serialized-commit request and response wire preserved");
  }
  if (typeof inventory.publicCommitWire?.note !== "string" || !inventory.publicCommitWire.note.includes("V1")) {
    fail("inventory public wire declaration needs the V1 rationale");
  }
  if (!Array.isArray(inventory.duties)) fail("inventory duties is not an array");
  assertExactStringSet(inventory.routeSet, ROUTES, "inventory routeSet");
  assertExactStringSet(inventory.durableFieldSet, DURABLE_FIELD_UNIVERSE, "inventory durableFieldSet");
  assertExactStringSet(inventory.callerSet, CALLER_UNIVERSE, "inventory callerSet");
  const declaredRoutes = new Set(inventory.routeSet);
  const runtimeRoutes = journalRouteSetFromRuntime(journal);
  if (runtimeRoutes.size !== declaredRoutes.size || [...runtimeRoutes].some((route) => !declaredRoutes.has(route))) {
    fail(`inventory routeSet diverges from JournalDurableObject.fetch: ${JSON.stringify([...runtimeRoutes])}`);
  }
  const classifiedRoutes = [];
  const classifiedDurableFields = [];
  const classifiedCallers = [];
  const ids = new Set();
  for (const duty of inventory.duties) {
    if (typeof duty?.id !== "string" || !ids.add(duty.id)) fail("every duty needs a unique id");
    if (!VERDICTS.has(duty.verdict)) fail(`${duty.id} has an invalid verdict`);
    asExactStringSet(duty.routes, `${duty.id} routes`);
    const expectedFields = DUTY_DURABLE_FIELDS[duty.id];
    const expectedCallers = DUTY_CALLERS[duty.id];
    if (expectedFields === undefined || expectedCallers === undefined) fail(`${duty.id} is outside the sealed duty universe`);
    assertExactStringSet(duty.durableFields, expectedFields, `${duty.id} durableFields`);
    assertExactStringSet(duty.callers, expectedCallers, `${duty.id} callers`);
    if (typeof duty.reason !== "string" || duty.reason.length === 0 || typeof duty.fixture !== "string" || duty.fixture.length === 0) {
      fail(`${duty.id} lacks a reason or fixture`);
    }
    if (!POST_G41_SURFACES.has(duty.postG41Surface)) {
      fail(`${duty.id} lacks an explicit post-G41 surface disposition`);
    }
    if (duty.postG41Surface === "DEAD_CODE_FOLLOW_UP" && !duty.reason.includes("dead code")) {
      fail(`${duty.id} must name its dead-code follow-up`);
    }
    classifiedRoutes.push(...duty.routes);
    classifiedDurableFields.push(...duty.durableFields);
    classifiedCallers.push(...duty.callers);
  }
  assertSameSet(ids, new Set(Object.keys(DUTY_DURABLE_FIELDS)), "inventory duty ids");
  const routeCounts = new Map(classifiedRoutes.map((route) => [route, classifiedRoutes.filter((candidate) => candidate === route).length]));
  for (const route of ROUTES) {
    if (routeCounts.get(route) !== 1) fail(`${route} must be classified by exactly one duty`);
  }
  if (classifiedRoutes.some((route) => !declaredRoutes.has(route))) fail("a duty classified a route outside the exact route universe");
  assertSameSet(new Set(classifiedDurableFields), new Set(inventory.durableFieldSet), "duty durable-field union");
  assertSameSet(new Set(classifiedCallers), new Set(inventory.callerSet), "duty caller union");
  if (inventory.retiredCommitAuthority?.singleJournalTerminalOutcome !== "RETIRED") fail("the old single terminal Journal outcome is not explicitly retired");
}

export function assertG41JournalRemovalContract(value) {
  const { inventory: inventoryText, commit, journal, repair, repairCli, probe, cloudflare, g42Worker, g38Tombstone, test, evidence, packageJson, ci } = value;
  assertInventory(parseInventory(inventoryText), journal);

  // Route table: this is deliberately checked against the implemented DO,
  // not reconstructed from the inventory itself.
  for (const token of [
    'path.startsWith(`${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/`)',
    'request.method === "GET" && path === "/state"',
    'request.method === "GET" && path === "/result"',
    'request.method === "GET" && path === "/repair/workset"',
    'request.method === "GET" && path === "/repair/observations"',
    'request.method === "POST" && path === "/admit"',
    'request.method === "POST" && path === "/transition"',
    'request.method === "POST" && path === "/reconcile"',
    'request.method === "POST" && path === "/reservation-failure"',
    'request.method === "POST" && path === "/takeover"',
    'request.method === "POST" && path === "/fault"',
    'request.method === "POST" && path === "/repair/observation"',
    'request.method === "POST" && path === "/debug/alarm"',
  ]) requireContains(journal, token, "Journal route table");

  // AC2: CommitWorker owns no JOURNAL namespace operation. Type declarations
  // are intentionally allowed because G42/repair compose the shared env.
  const commitPath = between(commit, "private async handleUntraced(", "private tagFor(", "CommitWorker normal path");
  requireAbsent(commitPath, "this.env.JOURNAL", "CommitWorker normal path");
  requireAbsent(commitPath, "journalFor(", "CommitWorker normal path");
  for (const route of ["/admit", "/transition", "/reconcile", "/reservation-failure", "/takeover"]) {
    requireAbsent(commitPath, `"${route}"`, "CommitWorker normal path");
  }
  requireContains(commitPath, "this.acquireReservations", "CommitWorker tag prepare path");
  requireContains(commitPath, "this.appendAllTags", "CommitWorker tag commit path");
  requireContains(commitPath, "this.cancelReservations", "CommitWorker tag cleanup path");
  requireContains(commitPath, "this.installPartialWriteFences", "CommitWorker partial source fact");
  requireContains(commitPath, 'fault === "after-reservations-before-allocation"', "first crash boundary");
  requireContains(commitPath, 'fault === "journal-cas-after-allocator"', "allocation crash boundary");
  requireContains(commitPath, 'fault === "sealing-after-cas"', "response-loss crash boundary");
  const cancel = between(commit, "private async cancelReservations", "private async finishReservationFailure", "CommitWorker cancellation");
  requireContains(cancel, 'forceTombstone: true', "CommitWorker cancellation");
  const partial = between(commit, "private async partialWriteOutcome", "private async successResponse", "CommitWorker partial outcome");
  requireContains(partial, "eventsDeleted: false", "CommitWorker partial outcome");
  requireContains(partial, "writtenTags", "CommitWorker partial outcome");
  requireContains(partial, "missingTags", "CommitWorker partial outcome");
  const partialFences = between(commit, "private async installPartialWriteFences", "private async partialWriteOutcome", "CommitWorker partial fences");
  requireContains(partialFences, '"/fence/install"', "CommitWorker partial fences");
  requireContains(partialFences, "PARTIAL_WRITE_FENCE_REASON", "CommitWorker partial fences");

  // Named non-commit callers and the retained G38 binding/class are live;
  // no false claim that removing normal commit mediation removed the class.
  requireContains(repair, 'this.journalGet(attemptId, "/repair/workset")', "RepairWorker");
  requireContains(repairCli, "new RepairWorker", "OperatorRepairCli");
  requireContains(probe, "runG42JournalProbeTrial", "G42 probe");
  requireContains(g42Worker, "runG42JournalProbeTrial(env.JOURNAL", "G42 primary route");
  requireContains(cloudflare, "class JournalDurableObject", "runtime Journal export");
  requireContains(g38Tombstone, 'name: "JOURNAL", class_name: "JournalDurableObject"', "G38 tombstone assertion");

  for (const token of [
    "AC2: performs zero JOURNAL namespace calls while the Tag positive control is live",
    "AC3: prepare failure cancels every already-reserved tag",
    "AC3: commit failure cancels every tag",
    "AC4 genuine interruption boundary 1:",
    "AC4 genuine interruption boundary 2:",
    "AC4 genuine interruption boundary 3:",
    "AC4 boundary 4:",
    "no CommitWorker cleanup",
    "without CommitWorker compensation",
    "superseded attempt epoch",
  ]) requireContains(test, token, "G41 fixture inventory");

  for (const token of [
    "SDT-G41 Journal-free serialized commit evidence",
    "G44 source registry",
    "AC5 deployment sampling is deferred",
    "No migration or compatibility fence",
    "means/06, means/07, and means/08",
  ]) requireContains(evidence, token, "G41 evidence");
  requireContains(packageJson, '"test:g41"', "package scripts");
  requireContains(ci, "ci-g41:", "CI G41 lane");
  requireContains(ci, "ci-g41", "verify dependencies");
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try {
    assertG41JournalRemovalContract(value);
  } catch {
    return;
  }
  fail(`forced-red mutation was accepted: ${label}`);
}

function selfTest() {
  assertG41JournalRemovalContract(snapshot());
  expectRed((value) => { value.inventory = value.inventory.replace('"POST /admit",\n', ""); }, "route classification omission");
  expectRed((value) => { value.inventory = value.inventory.replace('"response": "PRESERVED"', '"response": "CHANGED"'); }, "public response wire preservation disappearance");
  expectRed((value) => { value.journal = value.journal.replace('path === "/debug/alarm"', 'path === "/g41-unclassified-route"'); }, "Journal route diverges from classified inventory");
  expectRed((value) => { value.commit = value.commit.replace("this.acquireReservations", "this.g41MutantReservations"); }, "tag prepare removal");
  expectRed((value) => { value.commit = value.commit.replace("eventsDeleted: false", "eventsDeleted: true"); }, "partial write deletion claim");
  expectRed((value) => { value.repair = value.repair.replace('this.journalGet(attemptId, "/repair/workset")', 'this.g41NoJournal(attemptId, "/repair/workset")'); }, "repair caller disappearance");
  expectRed((value) => {
    value.inventory = value.inventory.replace(
      '"durableFields": ["journal.candidates", "journal.missingTags"]',
      '"durableFields": ["journal.missingTags"]',
    );
  }, "AC1 durable-field omission");
  expectRed((value) => {
    value.inventory = value.inventory.replace(
      '"callers": ["packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate", "packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker"]',
      '"callers": ["packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker"]',
    );
  }, "AC1 caller omission");
  expectRed((value) => { value.inventory = value.inventory.replace('"postG41Surface": "LIVE_NON_COMMIT"', '"postG41Surface": "UNCLASSIFIED"'); }, "surviving surface disposition omission");
  expectRed((value) => { value.test = value.test.replace("superseded attempt epoch", "g41 stale mutation"); }, "stale epoch fixture disappearance");
  process.stdout.write(`${JSON.stringify({
    selfTest: "g41-journal-duty-and-path-mutations-red",
    forcedRed: ["AC1 durable-field omission", "AC1 caller omission"],
  })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG41JournalRemovalContract(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g41-journal-removal-contract-passed" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

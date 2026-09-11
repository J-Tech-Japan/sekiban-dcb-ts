#!/usr/bin/env node
/**
 * SDT-G41 seals the pre-cleanup Journal duty inventory. SDT-G48 preserves
 * that historical seal while proving the implemented Journal surface is the
 * exact retained set and that every removed dispatch is absent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

const HISTORICAL_G41_ROUTES = Object.freeze([
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

const RETAINED_ROUTES = Object.freeze([
  "POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*",
  "GET /state",
  "GET /repair/workset",
  "GET /repair/observations",
  "POST /repair/observation",
]);

const REMOVED_ROUTES = Object.freeze([
  "GET /result",
  "POST /admit",
  "POST /transition",
  "POST /reservation-failure",
  "POST /reconcile",
  "POST /takeover",
  "POST /fault",
  "POST /debug/alarm",
]);

// These are sealed from pre-change main 7cc38a4. They remain a historical
// G41 universe, not an editable description of the post-cleanup object.
const HISTORICAL_G41_DURABLE_FIELD_UNIVERSE = Object.freeze([
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

const HISTORICAL_G41_CALLER_UNIVERSE = Object.freeze([
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

const POST_CLEANUP_DURABLE_FIELD_UNIVERSE = Object.freeze([
  "__sdt_g42_p1_alarm",
  "__sdt_g42_p1_index",
  "__sdt_g42_p1_record__:*",
  "journal",
  "journal.candidates",
  "journal.missingTags",
  "journal.repairObservations",
]);

const POST_CLEANUP_CALLER_UNIVERSE = Object.freeze([
  "packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker",
  "packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/state",
  "packages/dcb-runtime/src/index.ts:/journals/:attemptId/state",
  "packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate",
  "packages/dcb-runtime/src/repair/RepairWorker.ts:recordClearedObservations",
  "samples/meeting-room/src/worker.cloudflare-only.ts:handleG42JournalProbe",
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
  throw new Error("G41/G48 Journal contract check failed: " + message);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

function requireContains(source, token, context) {
  if (!source.includes(token)) fail(context + " is missing " + JSON.stringify(token));
}

function requireAbsent(source, token, context) {
  if (source.includes(token)) fail(context + " must not contain " + JSON.stringify(token));
}

function between(source, begin, end, context) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) fail(context + " boundaries are missing");
  return source.slice(start, finish);
}

function parseInventory(text) {
  try {
    return JSON.parse(text);
  } catch (caught) {
    fail("duty inventory is not valid JSON: " + (caught instanceof Error ? caught.message : String(caught)));
  }
}

function asExactStringSet(value, context) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    fail(context + " must be a non-empty string array");
  }
  const result = new Set(value);
  if (result.size !== value.length) fail(context + " contains duplicate members");
  return result;
}

function assertSameSet(actual, expected, context) {
  if (actual.size !== expected.size || [...expected].some((member) => !actual.has(member))) {
    fail(context + " is not an exact count/set match: " + JSON.stringify([...actual]));
  }
}

function assertExactStringSet(value, expectedValues, context) {
  assertSameSet(asExactStringSet(value, context), new Set(expectedValues), context);
}

/**
 * Derive every route from JournalDurableObject.fetch. The narrow parser makes
 * a new conditional form fail closed instead of becoming an unclassified
 * Journal surface.
 */
function journalRouteSetFromRuntime(journal) {
  const exact = [...journal.matchAll(/request\.method === "(GET|POST)" && path === "(\/[^"\n]+)"/g)]
    .map((match) => match[1] + " " + match[2]);
  const prefix = [...journal.matchAll(/request\.method === "(GET|POST)" && path\.startsWith\(\x60\$\{G42_JOURNAL_PROBE_INTERNAL_PREFIX\}\/\x60\)/g)];
  const allExactPathChecks = journal.match(/\bpath ===/g) ?? [];
  const allPrefixPathChecks = journal.match(/\bpath\.startsWith\(/g) ?? [];
  if (allExactPathChecks.length !== exact.length || allPrefixPathChecks.length !== prefix.length) {
    fail("Journal route table used a path conditional outside the closed parser grammar");
  }
  if (prefix.length !== 1 || prefix[0]?.[1] !== "POST") {
    fail("Journal route table must have exactly the fenced G42 POST prefix route");
  }
  if (exact.length !== RETAINED_ROUTES.length - 1 || new Set(exact).size !== exact.length) {
    fail("Journal route table has an unclassified or duplicate exact route conditional: " + JSON.stringify(exact));
  }
  return new Set(["POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*", ...exact]);
}

function assertImplementedRouteContract(journal) {
  const runtimeRoutes = journalRouteSetFromRuntime(journal);
  assertSameSet(runtimeRoutes, new Set(RETAINED_ROUTES), "implemented Journal retained route set");
  for (const route of REMOVED_ROUTES) {
    if (runtimeRoutes.has(route)) fail("removed Journal route was re-added: " + route);
    const path = route.slice(route.indexOf(" ") + 1);
    requireAbsent(journal, 'path === "' + path + '"', "removed Journal route dispatch");
  }
  requireContains(journal, 'request.method === "GET" && path === "/state"', "retained GET /state dispatch");
  return runtimeRoutes;
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
    index: read("packages/dcb-runtime/src/index.ts"),
    g42Worker: read("samples/meeting-room/src/worker.cloudflare-only.ts"),
    g38Tombstone: read("scripts/g38-tombstone-check.mjs"),
    test: read("test/g41-journal-removal.spec.ts"),
    evidence: read("docs/SDT-G41-evidence.md"),
    packageJson: read("package.json"),
    ci: read(".github/workflows/ci.yml"),
    laneManifest: JSON.parse(read("ci/lanes.json")),
  };
}

function assertHistoricalInventory(inventory) {
  if (inventory?.schema !== "sdt-g41-journal-duty-inventory/v1") fail("inventory schema is not sdt-g41-journal-duty-inventory/v1");
  if (inventory.preChangeMain !== "7cc38a4") fail("inventory must record the reviewed pre-change main identity");
  if (inventory.publicCommitWire?.request !== "PRESERVED" || inventory.publicCommitWire?.response !== "PRESERVED") {
    fail("inventory must separately declare the public serialized-commit request and response wire preserved");
  }
  if (typeof inventory.publicCommitWire?.note !== "string" || !inventory.publicCommitWire.note.includes("V1")) {
    fail("inventory public wire declaration needs the V1 rationale");
  }
  assertExactStringSet(inventory.routeSet, HISTORICAL_G41_ROUTES, "historical inventory routeSet");
  assertExactStringSet(inventory.durableFieldSet, HISTORICAL_G41_DURABLE_FIELD_UNIVERSE, "historical inventory durableFieldSet");
  assertExactStringSet(inventory.callerSet, HISTORICAL_G41_CALLER_UNIVERSE, "historical inventory callerSet");

  const historical = inventory.historicalG41Universe;
  if (historical?.preChangeMain !== "7cc38a4") fail("historical G41 universe must keep pre-change main 7cc38a4");
  assertExactStringSet(historical?.routeSet, HISTORICAL_G41_ROUTES, "historicalG41Universe routeSet");
  assertExactStringSet(historical?.durableFieldSet, HISTORICAL_G41_DURABLE_FIELD_UNIVERSE, "historicalG41Universe durableFieldSet");
  assertExactStringSet(historical?.callerSet, HISTORICAL_G41_CALLER_UNIVERSE, "historicalG41Universe callerSet");

  if (!Array.isArray(inventory.duties)) fail("inventory duties is not an array");
  const declaredRoutes = new Set(inventory.routeSet);
  const classifiedRoutes = [];
  const classifiedDurableFields = [];
  const classifiedCallers = [];
  const ids = new Set();
  for (const duty of inventory.duties) {
    if (typeof duty?.id !== "string" || !ids.add(duty.id)) fail("every duty needs a unique id");
    if (!VERDICTS.has(duty.verdict)) fail(duty.id + " has an invalid verdict");
    asExactStringSet(duty.routes, duty.id + " routes");
    const expectedFields = DUTY_DURABLE_FIELDS[duty.id];
    const expectedCallers = DUTY_CALLERS[duty.id];
    if (expectedFields === undefined || expectedCallers === undefined) fail(duty.id + " is outside the sealed duty universe");
    assertExactStringSet(duty.durableFields, expectedFields, duty.id + " durableFields");
    assertExactStringSet(duty.callers, expectedCallers, duty.id + " callers");
    if (typeof duty.reason !== "string" || duty.reason.length === 0 || typeof duty.fixture !== "string" || duty.fixture.length === 0) {
      fail(duty.id + " lacks a reason or fixture");
    }
    if (!POST_G41_SURFACES.has(duty.postG41Surface)) {
      fail(duty.id + " lacks an explicit post-G41 surface disposition");
    }
    if (duty.postG41Surface === "DEAD_CODE_FOLLOW_UP" && !duty.reason.includes("dead code")) {
      fail(duty.id + " must name its dead-code follow-up");
    }
    classifiedRoutes.push(...duty.routes);
    classifiedDurableFields.push(...duty.durableFields);
    classifiedCallers.push(...duty.callers);
  }
  assertSameSet(ids, new Set(Object.keys(DUTY_DURABLE_FIELDS)), "historical inventory duty ids");
  const routeCounts = new Map(classifiedRoutes.map((route) => [route, classifiedRoutes.filter((candidate) => candidate === route).length]));
  for (const route of HISTORICAL_G41_ROUTES) {
    if (routeCounts.get(route) !== 1) fail(route + " must be classified by exactly one historical duty");
  }
  if (classifiedRoutes.some((route) => !declaredRoutes.has(route))) fail("a historical duty classified a route outside the exact historical universe");
  assertSameSet(new Set(classifiedDurableFields), new Set(inventory.durableFieldSet), "historical duty durable-field union");
  assertSameSet(new Set(classifiedCallers), new Set(inventory.callerSet), "historical duty caller union");
  if (inventory.retiredCommitAuthority?.singleJournalTerminalOutcome !== "RETIRED") fail("the old single terminal Journal outcome is not explicitly retired");
}

function postCleanupDurableFieldSetFromImplementation(journal) {
  const actual = new Set();
  for (const token of [
    "G42_JOURNAL_PROBE_ALARM_KEY",
    "G42_JOURNAL_PROBE_INDEX_KEY",
    "g42ProbeStorageKey",
  ]) requireContains(journal, token, "G42 durable-field implementation");
  actual.add("__sdt_g42_p1_alarm");
  actual.add("__sdt_g42_p1_index");
  actual.add("__sdt_g42_p1_record__:*");

  requireContains(journal, 'const JOURNAL_KEY = "journal"', "legacy Journal storage key");
  actual.add("journal");
  requireContains(journal, "record.candidates.map", "RepairWorker workset implementation");
  actual.add("journal.candidates");
  requireContains(journal, "record.reconciliation?.missingTags", "RepairWorker workset implementation");
  actual.add("journal.missingTags");
  requireContains(journal, "record.repairObservations ?? []", "RepairWorker observation implementation");
  actual.add("journal.repairObservations");
  return actual;
}

function postCleanupCallerSetFromImplementation(value) {
  const actual = new Set();
  requireContains(value.repair, 'this.journalGet(attemptId, "/repair/workset")', "RepairWorker enumerate caller");
  actual.add("packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate");
  requireContains(value.repair, 'this.journalPost(item.attemptId, "/repair/observation"', "RepairWorker observation caller");
  actual.add("packages/dcb-runtime/src/repair/RepairWorker.ts:recordClearedObservations");
  requireContains(value.repairCli, "new RepairWorker", "OperatorRepairCli caller");
  actual.add("packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker");
  requireContains(value.cloudflare, 'url.pathname = match[2] ?? "/state"', "cloudflare direct state caller");
  actual.add("packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/state");
  requireContains(value.index, 'url.pathname = match[2] ?? "/state"', "index direct state caller");
  actual.add("packages/dcb-runtime/src/index.ts:/journals/:attemptId/state");
  requireContains(value.probe, "runG42JournalProbeTrial", "G42 probe caller");
  requireContains(value.g42Worker, "runG42JournalProbeTrial(env.JOURNAL", "G42 primary route");
  actual.add("samples/meeting-room/src/worker.cloudflare-only.ts:handleG42JournalProbe");
  return actual;
}

function assertPostCleanupUniverse(inventory, value) {
  const post = inventory.postCleanupExpectedUniverse;
  if (!post || typeof post !== "object") fail("postCleanupExpectedUniverse is missing");
  assertExactStringSet(post.routeSet, RETAINED_ROUTES, "post-cleanup expected routeSet");
  assertExactStringSet(post.durableFieldSet, POST_CLEANUP_DURABLE_FIELD_UNIVERSE, "post-cleanup expected durableFieldSet");
  assertExactStringSet(post.callerSet, POST_CLEANUP_CALLER_UNIVERSE, "post-cleanup expected callerSet");

  const runtimeRoutes = assertImplementedRouteContract(value.journal);
  assertSameSet(runtimeRoutes, asExactStringSet(post.routeSet, "post-cleanup expected routeSet"), "post-cleanup routes against implementation");
  assertSameSet(
    postCleanupDurableFieldSetFromImplementation(value.journal),
    asExactStringSet(post.durableFieldSet, "post-cleanup expected durableFieldSet"),
    "post-cleanup durable fields against implementation",
  );
  assertSameSet(
    postCleanupCallerSetFromImplementation(value),
    asExactStringSet(post.callerSet, "post-cleanup expected callerSet"),
    "post-cleanup callers against implementation",
  );
}

export function assertG41JournalRemovalContract(value) {
  const inventory = parseInventory(value.inventory);
  assertHistoricalInventory(inventory);
  assertPostCleanupUniverse(inventory, value);

  // AC2: CommitWorker owns no JOURNAL namespace operation. Type declarations
  // are intentionally allowed because G42/repair compose the shared env.
  const commitPath = between(value.commit, "private async handleUntraced(", "private tagFor(", "CommitWorker normal path");
  requireAbsent(commitPath, "this.env.JOURNAL", "CommitWorker normal path");
  requireAbsent(commitPath, "journalFor(", "CommitWorker normal path");
  for (const route of ["/admit", "/transition", "/reconcile", "/reservation-failure", "/takeover"]) {
    requireAbsent(commitPath, '"' + route + '"', "CommitWorker normal path");
  }
  requireContains(commitPath, "this.acquireReservations", "CommitWorker tag prepare path");
  requireContains(commitPath, "this.appendAllTags", "CommitWorker tag commit path");
  requireContains(commitPath, "this.cancelReservations", "CommitWorker tag cleanup path");
  requireContains(commitPath, "this.installPartialWriteFences", "CommitWorker partial source fact");
  requireContains(commitPath, 'fault === "after-reservations-before-allocation"', "first crash boundary");
  requireContains(commitPath, 'fault === "journal-cas-after-allocator"', "allocation crash boundary");
  requireContains(commitPath, 'fault === "sealing-after-cas"', "response-loss crash boundary");
  const cancel = between(value.commit, "private async cancelReservations", "private async finishReservationFailure", "CommitWorker cancellation");
  requireContains(cancel, "forceTombstone: true", "CommitWorker cancellation");
  const partial = between(value.commit, "private async partialWriteOutcome", "private async successResponse", "CommitWorker partial outcome");
  requireContains(partial, "eventsDeleted: false", "CommitWorker partial outcome");
  requireContains(partial, "writtenTags", "CommitWorker partial outcome");
  requireContains(partial, "missingTags", "CommitWorker partial outcome");
  const partialFences = between(value.commit, "private async installPartialWriteFences", "private async partialWriteOutcome", "CommitWorker partial fences");
  requireContains(partialFences, '"/fence/install"', "CommitWorker partial fences");
  requireContains(partialFences, "PARTIAL_WRITE_FENCE_REASON", "CommitWorker partial fences");

  // The class, binding, named non-commit callers, and G38 tombstone stay live.
  requireContains(value.cloudflare, "class JournalDurableObject", "runtime Journal export");
  requireContains(value.g38Tombstone, 'name: "JOURNAL", class_name: "JournalDurableObject"', "G38 tombstone assertion");

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
  ]) requireContains(value.test, token, "G41 fixture inventory");

  for (const token of [
    "SDT-G41 Journal-free serialized commit evidence",
    "G44 source registry",
    "AC5 deployment sampling is deferred",
    "No migration or compatibility fence",
    "means/06, means/07, and means/08",
  ]) requireContains(value.evidence, token, "G41 evidence");
  requireContains(value.packageJson, '"test:g41"', "package scripts");
  const legacyWorkflowWiring = value.ci.includes("ci-g41:") && value.ci.includes("ci-g41");
  const lane = value.laneManifest?.lanes?.find((entry) => entry?.name === "cheap");
  const normal = lane?.commands?.find((entry) => entry?.id === "g41");
  const forcedRed = lane?.commands?.find((entry) => entry?.id === "g41-red");
  const manifestWiring = normal?.command === "npm run test:g41" && forcedRed?.command === "npm run test:g41:forced-red" && forcedRed?.env?.SDT_G41_FORCE_FAILURE === "1" && forcedRed?.expect === "red";
  if (!legacyWorkflowWiring && !manifestWiring) fail("G41 lane and forced-red proof are absent from both the legacy workflow and the manifest");
}

function mutateInventory(text, callback) {
  const inventory = parseInventory(text);
  callback(inventory);
  return JSON.stringify(inventory, null, 2) + "\n";
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try {
    assertG41JournalRemovalContract(value);
  } catch {
    return label;
  }
  fail("forced-red mutation was accepted: " + label);
}

function selfTest() {
  assertG41JournalRemovalContract(snapshot());
  const forcedRed = [];
  forcedRed.push(expectRed((value) => {
    value.inventory = mutateInventory(value.inventory, (inventory) => {
      inventory.routeSet = inventory.routeSet.filter((route) => route !== "POST /admit");
    });
  }, "historical route classification omission"));
  forcedRed.push(expectRed((value) => {
    value.inventory = value.inventory.replace('"response": "PRESERVED"', '"response": "CHANGED"');
  }, "public response wire preservation disappearance"));
  forcedRed.push(expectRed((value) => {
    value.journal = value.journal.replace('path === "/repair/observations"', 'path === "/g41-unclassified-route"');
  }, "unclassified Journal route"));
  forcedRed.push(expectRed((value) => {
    value.commit = value.commit.replace("this.acquireReservations", "this.g41MutantReservations");
  }, "tag prepare removal"));
  forcedRed.push(expectRed((value) => {
    value.commit = value.commit.replace("eventsDeleted: false", "eventsDeleted: true");
  }, "partial write deletion claim"));
  forcedRed.push(expectRed((value) => {
    value.repair = value.repair.replace('this.journalGet(attemptId, "/repair/workset")', 'this.g41NoJournal(attemptId, "/repair/workset")');
  }, "repair caller disappearance"));
  forcedRed.push(expectRed((value) => {
    value.inventory = mutateInventory(value.inventory, (inventory) => {
      const duty = inventory.duties.find((entry) => entry.id === "J04-repair-workset");
      duty.durableFields = ["journal.missingTags"];
    });
  }, "historical durable-field omission"));
  forcedRed.push(expectRed((value) => {
    value.inventory = mutateInventory(value.inventory, (inventory) => {
      const duty = inventory.duties.find((entry) => entry.id === "J04-repair-workset");
      duty.callers = ["packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker"];
    });
  }, "historical caller omission"));
  forcedRed.push(expectRed((value) => {
    value.inventory = value.inventory.replace('"postG41Surface": "LIVE_NON_COMMIT"', '"postG41Surface": "UNCLASSIFIED"');
  }, "surviving historical surface disposition omission"));
  forcedRed.push(expectRed((value) => {
    value.test = value.test.replace("superseded attempt epoch", "g41 stale mutation");
  }, "stale epoch fixture disappearance"));
  forcedRed.push(expectRed((value) => {
    value.journal = value.journal.replace(
      'if (request.method === "GET" && path === "/repair/workset") {',
      'if (request.method === "GET" && path === "/result") { return json({ mutant: true }); }\n    if (request.method === "GET" && path === "/repair/workset") {',
    );
  }, "re-adding a removed route"));
  forcedRed.push(expectRed((value) => {
    value.journal = value.journal.replace('path === "/state"', 'path === "/g48-removed-retained-route"');
  }, "removing a retained route"));
  forcedRed.push(expectRed((value) => {
    value.inventory = mutateInventory(value.inventory, (inventory) => {
      inventory.postCleanupExpectedUniverse.durableFieldSet =
        inventory.postCleanupExpectedUniverse.durableFieldSet.filter((field) => field !== "journal.repairObservations");
    });
  }, "post-cleanup durable-field omission"));
  forcedRed.push(expectRed((value) => {
    value.inventory = mutateInventory(value.inventory, (inventory) => {
      inventory.postCleanupExpectedUniverse.callerSet =
        inventory.postCleanupExpectedUniverse.callerSet.filter((caller) => caller !== "packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate");
    });
  }, "post-cleanup caller omission"));
  process.stdout.write(JSON.stringify({
    selfTest: "g48-exact-retained-routes-and-removed-route-absence",
    forcedRed,
  }) + "\n");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG41JournalRemovalContract(snapshot());
  process.stdout.write(JSON.stringify({ result: "g41-g48-journal-contract-passed" }) + "\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

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
  if (!Array.isArray(inventory.routeSet) || !Array.isArray(inventory.duties)) fail("inventory routeSet/duties are not arrays");
  const declaredRoutes = new Set(inventory.routeSet);
  if (declaredRoutes.size !== ROUTES.length || ROUTES.some((route) => !declaredRoutes.has(route))) {
    fail(`inventory routeSet is not the exact Journal route universe: ${JSON.stringify(inventory.routeSet)}`);
  }
  const runtimeRoutes = journalRouteSetFromRuntime(journal);
  if (runtimeRoutes.size !== declaredRoutes.size || [...runtimeRoutes].some((route) => !declaredRoutes.has(route))) {
    fail(`inventory routeSet diverges from JournalDurableObject.fetch: ${JSON.stringify([...runtimeRoutes])}`);
  }
  const classifiedRoutes = [];
  const ids = new Set();
  for (const duty of inventory.duties) {
    if (typeof duty?.id !== "string" || !ids.add(duty.id)) fail("every duty needs a unique id");
    if (!VERDICTS.has(duty.verdict)) fail(`${duty.id} has an invalid verdict`);
    for (const field of ["routes", "durableFields", "callers"]) {
      if (!Array.isArray(duty[field]) || duty[field].length === 0 || !duty[field].every((value) => typeof value === "string" && value.length > 0)) {
        fail(`${duty.id} has no enumerable ${field}`);
      }
    }
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
  }
  const routeCounts = new Map(classifiedRoutes.map((route) => [route, classifiedRoutes.filter((candidate) => candidate === route).length]));
  for (const route of ROUTES) {
    if (routeCounts.get(route) !== 1) fail(`${route} must be classified by exactly one duty`);
  }
  if (classifiedRoutes.some((route) => !declaredRoutes.has(route))) fail("a duty classified a route outside the exact route universe");
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
    "AC4 boundary 1:",
    "AC4 boundary 2:",
    "AC4 boundary 3:",
    "AC4 boundary 4:",
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
  expectRed((value) => { value.inventory = value.inventory.replace('"postG41Surface": "LIVE_NON_COMMIT"', '"postG41Surface": "UNCLASSIFIED"'); }, "surviving surface disposition omission");
  expectRed((value) => { value.test = value.test.replace("superseded attempt epoch", "g41 stale mutation"); }, "stale epoch fixture disappearance");
  process.stdout.write(`${JSON.stringify({ selfTest: "g41-journal-duty-and-path-mutations-red" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG41JournalRemovalContract(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g41-journal-removal-contract-passed" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

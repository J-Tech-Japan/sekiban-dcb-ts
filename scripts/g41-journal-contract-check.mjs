#!/usr/bin/env node
/** SDT-G41 current Journal route, field, caller and commit-path contract. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const RETAINED_ROUTES = Object.freeze([
  "POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*", "GET /state", "GET /repair/workset",
  "GET /repair/observations", "POST /repair/observation",
]);
const REMOVED_ROUTES = Object.freeze(["GET /result", "POST /admit", "POST /transition", "POST /reservation-failure", "POST /reconcile", "POST /takeover", "POST /fault", "POST /debug/alarm"]);
const RETAINED_FIELDS = Object.freeze(["__sdt_g42_p1_alarm", "__sdt_g42_p1_index", "__sdt_g42_p1_record__:*", "journal", "journal.candidates", "journal.missingTags", "journal.repairObservations"]);
const RETAINED_CALLERS = Object.freeze([
  "packages/dcb-runtime/src/cli/OperatorRepairCli.ts:handleOperatorRepair -> RepairWorker",
  "packages/dcb-runtime/src/cloudflare.ts:/journals/:attemptId/state",
  "packages/dcb-runtime/src/index.ts:/journals/:attemptId/state",
  "packages/dcb-runtime/src/repair/RepairWorker.ts:enumerate",
  "packages/dcb-runtime/src/repair/RepairWorker.ts:recordClearedObservations",
  "samples/meeting-room/src/worker.cloudflare-only.ts:handleG42JournalProbe",
]);
const DUTIES = Object.freeze({
  "J01-g42-private-probe": { routes: [RETAINED_ROUTES[0]], fields: ["__sdt_g42_p1_record__:*", "__sdt_g42_p1_index", "__sdt_g42_p1_alarm"], callers: [RETAINED_CALLERS[5]] },
  "J02-direct-state": { routes: ["GET /state"], fields: ["journal"], callers: [RETAINED_CALLERS[1], RETAINED_CALLERS[2]] },
  "J04-repair-workset": { routes: ["GET /repair/workset"], fields: ["journal.candidates", "journal.missingTags"], callers: [RETAINED_CALLERS[3], RETAINED_CALLERS[0]] },
  "J05-repair-observations": { routes: ["GET /repair/observations", "POST /repair/observation"], fields: ["journal.repairObservations"], callers: [RETAINED_CALLERS[4], RETAINED_CALLERS[0]] },
});

function fail(message) { throw new Error(`G41 Journal contract check failed: ${message}`); }
function read(relative) { return readFileSync(resolve(root, relative), "utf8"); }
function requireContains(source, token, label) { if (!source.includes(token)) fail(`${label} is missing ${JSON.stringify(token)}`); }
function requireAbsent(source, token, label) { if (source.includes(token)) fail(`${label} must not contain ${JSON.stringify(token)}`); }
function between(source, begin, end, label) { const start = source.indexOf(begin); const finish = source.indexOf(end, start + begin.length); if (start < 0 || finish < 0) fail(`${label} boundaries are missing`); return source.slice(start, finish); }
function exactSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((item) => !actual.includes(item))) fail(`${label} is not exact: ${JSON.stringify(actual)}`);
}
function parseInventory(text) { try { return JSON.parse(text); } catch (error) { fail(`duty inventory is not valid JSON: ${error.message}`); } }

function journalRoutes(journal) {
  const exact = [...journal.matchAll(/request\.method === "(GET|POST)" && path === "(\/[^"\n]+)"/g)].map((match) => `${match[1]} ${match[2]}`);
  const prefix = [...journal.matchAll(/request\.method === "(GET|POST)" && path\.startsWith\(\x60\$\{G42_JOURNAL_PROBE_INTERNAL_PREFIX\}\/\x60\)/g)];
  if (journal.match(/\bpath ===/g)?.length !== exact.length || journal.match(/\bpath\.startsWith\(/g)?.length !== prefix.length || prefix.length !== 1 || prefix[0][1] !== "POST") fail("Journal route table is outside the closed parser grammar");
  return new Set(["POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*", ...exact]);
}

function assertInventory(inventory) {
  const keys = Object.keys(inventory).sort();
  const expectedKeys = ["callerSet", "duties", "durableFieldSet", "publicCommitWire", "routeSet", "schema", "scope"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) fail(`inventory keys are not current-only: ${keys.join(",")}`);
  if (inventory.schema !== "sdt-g41-journal-duty-inventory/v1") fail("inventory schema mismatch");
  if (typeof inventory.scope !== "string" || inventory.scope.length === 0) fail("inventory scope is missing");
  if (inventory.publicCommitWire?.request !== "PRESERVED" || inventory.publicCommitWire?.response !== "PRESERVED" || !inventory.publicCommitWire.note?.includes("V1")) fail("publicCommitWire PRESERVED/V1 guarantee is missing");
  exactSet(inventory.routeSet, RETAINED_ROUTES, "inventory routeSet");
  exactSet(inventory.durableFieldSet, RETAINED_FIELDS, "inventory durableFieldSet");
  exactSet(inventory.callerSet, RETAINED_CALLERS, "inventory callerSet");
  if (!Array.isArray(inventory.duties) || inventory.duties.length !== 4) fail("inventory duty count is not four");
  const seen = new Set();
  for (const duty of inventory.duties) {
    if (!DUTIES[duty.id] || seen.has(duty.id)) fail(`unexpected or duplicate duty ${duty.id}`);
    seen.add(duty.id);
    const expected = DUTIES[duty.id];
    exactSet(duty.routes, expected.routes, `${duty.id} routes`);
    exactSet(duty.durableFields, expected.fields, `${duty.id} durableFields`);
    exactSet(duty.callers, expected.callers, `${duty.id} callers`);
    if (duty.verdict !== "STILL_REQUIRED" || typeof duty.reason !== "string" || typeof duty.fixture !== "string") fail(`${duty.id} current duty metadata is incomplete`);
  }
  if (seen.size !== 4) fail("inventory duty ids are incomplete");
}

function snapshot() {
  return {
    inventory: read("contracts/g41-journal-duty-inventory.json"), commit: read("packages/dcb-runtime/src/commit/CommitWorker.ts"),
    journal: read("packages/dcb-runtime/src/journal/JournalDurableObject.ts"), repair: read("packages/dcb-runtime/src/repair/RepairWorker.ts"),
    repairCli: read("packages/dcb-runtime/src/cli/OperatorRepairCli.ts"), probe: read("packages/dcb-runtime/src/journal/JournalFirstTouchProbe.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"), index: read("packages/dcb-runtime/src/index.ts"),
    g42Worker: read("samples/meeting-room/src/worker.cloudflare-only.ts"), test: read("test/g41-journal-removal.spec.ts"),
    packageJson: read("package.json"), ci: read(".github/workflows/ci.yml"), laneManifest: JSON.parse(read("ci/lanes.json")),
  };
}

export function assertG41JournalRemovalContract(value) {
  const inventory = parseInventory(value.inventory);
  assertInventory(inventory);
  const runtimeRoutes = journalRoutes(value.journal);
  exactSet([...runtimeRoutes], RETAINED_ROUTES, "implemented Journal retained route set");
  for (const route of REMOVED_ROUTES) { const path = route.slice(route.indexOf(" ") + 1); requireAbsent(value.journal, `path === "${path}"`, "removed Journal route dispatch"); }
  const commitPath = between(value.commit, "private async handleUntraced(", "private tagFor(", "CommitWorker normal path");
  requireAbsent(commitPath, "this.env.JOURNAL", "CommitWorker normal path"); requireAbsent(commitPath, "journalFor(", "CommitWorker normal path");
  for (const route of ["/admit", "/transition", "/reconcile", "/reservation-failure", "/takeover"]) requireAbsent(commitPath, `"${route}"`, "CommitWorker normal path");
  for (const token of ["this.acquireReservations", "this.appendAllTags", "this.cancelReservations", "this.installPartialWriteFences", 'fault === "after-reservations-before-allocation"', 'fault === "journal-cas-after-allocator"', 'fault === "sealing-after-cas"']) requireContains(commitPath, token, "CommitWorker current path");
  requireContains(between(value.commit, "private async cancelReservations", "private async finishReservationFailure", "CommitWorker cancellation"), "forceTombstone: true", "CommitWorker cancellation");
  const partial = between(value.commit, "private async partialWriteOutcome", "private async successResponse", "CommitWorker partial outcome");
  for (const token of ["eventsDeleted: false", "writtenTags", "missingTags"]) requireContains(partial, token, "CommitWorker partial outcome");
  for (const token of ['"/fence/install"', "PARTIAL_WRITE_FENCE_REASON"]) requireContains(between(value.commit, "private async installPartialWriteFences", "private async partialWriteOutcome", "CommitWorker partial fences"), token, "CommitWorker partial fences");
  requireContains(value.cloudflare, "class JournalDurableObject", "runtime Journal export");
  requireContains(value.repair, 'this.journalGet(attemptId, "/repair/workset")', "RepairWorker enumerate caller");
  requireContains(value.repair, 'this.journalPost(item.attemptId, "/repair/observation"', "RepairWorker observation caller");
  requireContains(value.repairCli, "new RepairWorker", "OperatorRepairCli caller");
  requireContains(value.cloudflare, 'url.pathname = match[2] ?? "/state"', "cloudflare direct state caller");
  requireContains(value.index, 'url.pathname = match[2] ?? "/state"', "index direct state caller");
  requireContains(value.probe, "runG42JournalProbeTrial", "G42 probe caller");
  requireContains(value.g42Worker, "runG42JournalProbeTrial(journalBinding(env)", "G42 primary route");
  for (const token of ["AC2: performs zero JOURNAL namespace calls while the Tag positive control is live", "AC3: prepare failure cancels every already-reserved tag", "AC3: commit failure cancels every tag", "AC4 genuine interruption boundary 1:", "AC4 genuine interruption boundary 2:", "AC4 genuine interruption boundary 3:", "AC4 boundary 4:", "no CommitWorker cleanup", "without CommitWorker compensation", "superseded attempt epoch"]) requireContains(value.test, token, "G41 focused fixture inventory");
  requireContains(value.packageJson, '"test:g41"', "package scripts");
  const lane = value.laneManifest.lanes.find((entry) => entry.name === "cheap"); const normal = lane?.commands.find((entry) => entry.id === "g41"); const forcedRed = lane?.commands.find((entry) => entry.id === "g41-red");
  if (normal?.command !== "npm run test:g41" || forcedRed?.command !== "npm run test:g41:forced-red" || forcedRed?.env?.SDT_G41_FORCE_FAILURE !== "1" || forcedRed?.expect !== "red") fail("G41 lane and forced-red proof are absent");
}

function mutateInventory(text, callback) { const inventory = parseInventory(text); callback(inventory); return JSON.stringify(inventory, null, 2) + "\n"; }
function expectRed(mutator, label) { const value = snapshot(); mutator(value); try { assertG41JournalRemovalContract(value); } catch { return label; } fail(`forced-red mutation was accepted: ${label}`); }

function selfTest() {
  assertG41JournalRemovalContract(snapshot());
  const forcedRed = [
    expectRed((value) => { value.inventory = mutateInventory(value.inventory, (inventory) => { inventory.routeSet = inventory.routeSet.filter((route) => route !== "GET /state"); }); }, "retained route omission"),
    expectRed((value) => { value.inventory = value.inventory.replace('"response": "PRESERVED"', '"response": "CHANGED"'); }, "public response wire preservation disappearance"),
    expectRed((value) => { value.journal = value.journal.replace('path === "/repair/observations"', 'path === "/g41-unclassified-route"'); }, "unclassified Journal route"),
    expectRed((value) => { value.commit = value.commit.replace("this.acquireReservations", "this.g41MutantReservations"); }, "tag prepare removal"),
    expectRed((value) => { value.commit = value.commit.replace("eventsDeleted: false", "eventsDeleted: true"); }, "partial write deletion claim"),
    expectRed((value) => { value.repair = value.repair.replace('this.journalGet(attemptId, "/repair/workset")', 'this.g41NoJournal(attemptId, "/repair/workset")'); }, "repair caller disappearance"),
    expectRed((value) => { value.inventory = mutateInventory(value.inventory, (inventory) => { inventory.duties.find((entry) => entry.id === "J04-repair-workset").durableFields = ["journal.missingTags"]; }); }, "current durable-field omission"),
    expectRed((value) => { value.inventory = mutateInventory(value.inventory, (inventory) => { inventory.duties.find((entry) => entry.id === "J04-repair-workset").callers = [RETAINED_CALLERS[0]]; }); }, "current caller omission"),
    expectRed((value) => { value.test = value.test.replace("superseded attempt epoch", "g41 stale mutation"); }, "focused fixture disappearance"),
  ];
  process.stdout.write(`${JSON.stringify({ selfTest: "g41-current-only-retained-routes-and-removed-route-absence", forcedRed })}\n`);
}

function main() { if (process.argv.includes("--self-test")) return selfTest(); assertG41JournalRemovalContract(snapshot()); process.stdout.write(JSON.stringify({ result: "g41-current-only-journal-contract-passed" }) + "\n"); }
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

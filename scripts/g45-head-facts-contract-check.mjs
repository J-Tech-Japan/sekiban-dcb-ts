#!/usr/bin/env node
/** SDT-G45 source/fixture contract guard for the scalar Tag head-facts seam. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function fail(message) {
  throw new Error(`G45 head-facts contract check failed: ${message}`);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

function between(source, begin, end, label) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) fail(`${label} boundaries are missing`);
  return source.slice(start, finish);
}

function requireContains(source, token, label) {
  if (!source.includes(token)) fail(`${label} is missing ${JSON.stringify(token)}`);
}

function requireAbsent(source, token, label) {
  if (source.includes(token)) fail(`${label} must not contain ${JSON.stringify(token)}`);
}

function snapshot() {
  return {
    tag: read("packages/dcb-runtime/src/tag/TagDurableObject.ts"),
    commit: read("packages/dcb-runtime/src/commit/CommitWorker.ts"),
    test: read("test/g45-head-facts.spec.ts"),
    evidence: read("docs/SDT-G45-evidence.md"),
    packageJson: read("package.json"),
    ci: read(".github/workflows/ci.yml"),
    laneManifest: JSON.parse(read("ci/lanes.json")),
  };
}

export function assertG45HeadFactsContract(value) {
  const { tag, commit, test, evidence, packageJson, ci } = value;
  const route = between(tag, 'if (request.method === "GET" && url.pathname === "/head-facts")', 'if (request.method === "GET" && url.pathname === "/state")', "head-facts route");
  requireContains(route, "this.readHeadFacts(tag)", "head-facts route");
  requireContains(route, 'error(404, "tag_not_found"', "head-facts route");
  requireContains(route, 'error(409, "tag_identity_conflict"', "head-facts route");

  const reader = between(tag, "private readHeadFacts", "private async obligationArtifact", "head-facts reader");
  requireContains(reader, "SELECT tag FROM tag_identity WHERE singleton = 1", "head-facts reader");
  requireContains(reader, "SELECT head_suid, version, updated_at", "head-facts reader");
  requireContains(reader, "SELECT head_suid FROM tag_head WHERE singleton = 1", "head-facts reader");
  requireAbsent(reader, "readStoredRecord(", "head-facts reader");
  requireAbsent(reader, "requireG32TagRecord(", "head-facts reader");
  requireAbsent(reader, "SELECT event_json FROM tag_event", "head-facts reader");

  const success = between(commit, "private async successResponse", "private noApplicationOutcome", "commit success response");
  requireContains(success, "writes?.tagWriteFacts.get(tag)", "commit success response");
  requireAbsent(success, 'this.tagRequest(tag, "/head-facts"', "commit success response");
  requireAbsent(success, 'this.tagRequest(tag, "/state"', "commit success response");
  requireContains(success, 'stageScope.fork().span("S14"', "commit success response span identity");

  for (const token of [
    "real /head-facts is table-aware",
    "commit success response uses the append transaction facts and does not read head facts",
    "real handler head-facts read has a singleton non-event SQL set at every history point",
    "AC3 checker rejects each standalone falsification",
    "historyProportionalLimit",
    "constantTagEventLimit",
    "intermediateOnlySpike",
  ]) requireContains(test, token, "G45 runtime fixture inventory");

  for (const token of [
    "SDT-G45 scalar Tag head-facts evidence",
    "all-points history measurement",
    "SerializedReadWorker.readTag",
    "JournalDurableObject.requeryCommitRecords",
    "BootstrapCoordinatorDurableObject.verify",
    "RepairWorker",
    "No deployed-primary sampling window is claimed",
  ]) requireContains(evidence, token, "G45 evidence inventory");

  requireContains(packageJson, '"test:g45"', "package scripts");
  const legacyWorkflowWiring = ci.includes("ci-g45:") && ci.includes("ci-g45");
  const lane = value.laneManifest?.lanes?.find((entry) => entry?.name === "cheap");
  const normal = lane?.commands?.find((entry) => entry?.id === "g45");
  const forcedRed = lane?.commands?.find((entry) => entry?.id === "g45-red");
  const manifestWiring = normal?.command === "npm run test:g45" && forcedRed?.command === "npm run test:g45:forced-red" && forcedRed?.env?.SDT_G45_FORCE_FAILURE === "1" && forcedRed?.expect === "red";
  if (!legacyWorkflowWiring && !manifestWiring) fail("G45 lane and forced-red proof are absent from both the legacy workflow and the manifest");
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try {
    assertG45HeadFactsContract(value);
  } catch {
    return;
  }
  fail(`forced-red mutation was accepted: ${label}`);
}

function selfTest() {
  assertG45HeadFactsContract(snapshot());
  expectRed((value) => { value.commit = value.commit.replace("private async successResponse", "private async successResponse\nthis.tagRequest(tag, \"/head-facts\""); }, "commit reads head facts on success");
  expectRed((value) => { value.tag = value.tag.replace("private readHeadFacts", "private readG45MutantFacts"); }, "head-facts reader is removed");
  expectRed((value) => { value.test = value.test.replaceAll("intermediateOnlySpike", "endpointOnlySpike"); }, "all-points checker fixture is removed");
  expectRed((value) => { value.test = value.test.replaceAll("constantTagEventLimit", "constantLimitMutationRemoved"); }, "constant tag_event LIMIT fixture is removed");
  expectRed((value) => { value.evidence = value.evidence.replace("all-points history measurement", "endpoint-only history measurement"); }, "all-points evidence is removed");
  process.stdout.write(`${JSON.stringify({ selfTest: "g45-head-facts-contract-mutations-red" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG45HeadFactsContract(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g45-head-facts-contract-passed" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

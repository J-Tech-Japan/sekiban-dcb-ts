#!/usr/bin/env node
/**
 * SDT-G46 structural contract guard.
 *
 * The TagState cache is useful only when it has one bounded source authority:
 * G45 scalar head facts + G43 incremental rows.  Keep the source shape,
 * replay lifecycle, deploy binding, and fixtures visible to CI so a local
 * optimization cannot quietly reintroduce a full-record projection path.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function fail(message) {
  throw new Error(`G46 TagState contract check failed: ${message}`);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

function requireContains(source, token, label) {
  if (!source.includes(token)) fail(`${label} is missing ${JSON.stringify(token)}`);
}

function requireAbsent(source, token, label) {
  if (source.includes(token)) fail(`${label} must not contain ${JSON.stringify(token)}`);
}

function between(source, begin, end, label) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) fail(`${label} boundaries are missing`);
  return source.slice(start, finish);
}

function snapshot() {
  const sampleConfigs = readdirSync(resolve(root, "samples/meeting-room"))
    .filter((name) => /^wrangler(?:\..+)?\.jsonc$/.test(name))
    .sort()
    .map((name) => [name, read(`samples/meeting-room/${name}`)]);
  return {
    tagState: read("packages/dcb-runtime/src/tagstate/TagStateDurableObject.ts"),
    tag: read("packages/dcb-runtime/src/tag/TagDurableObject.ts"),
    readWorker: read("packages/dcb-runtime/src/read/SerializedReadWorker.ts"),
    runtime: read("packages/dcb-runtime/src/index.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"),
    test: read("test/g46-tagstate.spec.ts"),
    evidence: read("docs/SDT-G46-evidence.md"),
    packageJson: read("package.json"),
    ci: read(".github/workflows/ci.yml"),
    rootConfig: read("wrangler.jsonc"),
    sampleConfigs,
  };
}

export function assertG46TagStateContract(value) {
  const {
    tagState, tag, readWorker, runtime, cloudflare, test, evidence,
    packageJson, ci, rootConfig, sampleConfigs,
  } = value;

  // AC1/AC3: a distinct SQLite cache owns only identity plus resumable
  // projection state.  It must never rebuild by reading a whole tag record.
  for (const token of [
    "export class TagStateDurableObject implements DurableObject",
    "CREATE TABLE IF NOT EXISTS tag_state_identity",
    "CREATE TABLE IF NOT EXISTS tag_state_cache",
    "CHECK (phase IN ('READY', 'REBUILDING'))",
    "target_projector_version",
    "frozen_through",
    "replay_cursor",
    "accumulator_json",
    "rebuild_id",
    "scopeIdFor(namespace, {",
    "this.beginRebuild(projector, \"projector-version-mismatch\")",
    "tag_state_rebuild_in_progress",
    "tag_state_rebuild_interrupted",
    "this.transaction(() => {",
  ]) requireContains(tagState, token, "TagStateDO lifecycle");
  requireAbsent(tagState, "DEPLOYED_PROJECTOR_REGISTRY", "TagStateDO projector authority");
  requireAbsent(tagState, "g43TagStateRebuild", "TagStateDO source path");
  requireAbsent(tagState, 'pathname === "/state"', "TagStateDO source path");

  // AC2: the source call is a private direct-DO adapter around exactly the
  // G43 method. Its first page freezes G45 head facts and later pages retain
  // that same through boundary.
  const source = between(tagState, "private async readSource(", "private assertSourcePage(", "TagStateDO source reader");
  for (const token of [
    "this.g46SourceNamespace ?? this.env.TAG",
    '"https://tag-source.internal/__internal/g46/tag-state-incremental"',
    '"x-sdt-g46-source-read": "1"',
    "TAG_STATE_SOURCE_PAGE_LIMIT",
    "this.assertSourcePage(cursor, through, page)",
  ]) requireContains(source, token, "TagStateDO bounded source");
  requireAbsent(source, '"/state"', "TagStateDO bounded source");
  requireAbsent(source, "g43TagStateRebuild", "TagStateDO bounded source");

  const delta = between(tagState, "private async beginDeltaOrRespondReady(", "private async continueRebuild(", "TagStateDO normal delta");
  requireContains(delta, "this.readSource(identity, cache.lastSuid, undefined)", "TagStateDO normal delta");
  requireContains(delta, "frozenThrough: page.through", "TagStateDO normal delta");

  const tagAdapter = between(tag, 'url.pathname === "/__internal/g46/tag-state-incremental"', "// This is an internal Tag-to-scanner seam", "G46 direct-DO source adapter");
  requireContains(tagAdapter, 'request.headers.get("x-sdt-g46-source-read") !== "1"', "G46 direct-DO source adapter");
  requireContains(tagAdapter, "this.g43TagStateIncrementalCatchUp(parsed.value)", "G46 direct-DO source adapter");
  requireContains(tagAdapter, 'error(409, "tag_identity_conflict"', "G46 direct-DO source adapter");

  const incremental = between(tag, "async g43TagStateIncrementalCatchUp(", "/** Full replay remains intentionally linear", "G43 incremental source");
  for (const token of [
    "const facts = this.readHeadFacts(input.tag);",
    "const through = input.through ?? facts?.head ?? \"\";",
    "this.g43ReadAfter(input.cursor, input.limit, through)",
    "completeThrough: complete ? through : null",
  ]) requireContains(incremental, token, "G43/G45 frozen source");
  requireAbsent(incremental, "g43TagStateRebuild", "G43/G45 frozen source");

  // AC1/AC5/AC6: user input is syntax parsed and then validated by the same
  // composition registry before the TagState object is addressed.  The read
  // route does not quietly call the SafeWindow or Tag full-state path.
  const readRoute = between(readWorker, "private async tagState(", "private async ensureWindowDeterminate(", "tag-state read route");
  for (const token of [
    "this.registry.resolve(identity.tagProjector)",
    'error(404, "tag_state_unknown_projector"',
    'error(503, "tag_state_projector_registry_failure"',
    "this.env.TAG_STATE.get(scopeIdFor(this.env.TAG_STATE, {",
    'doClass: "tag-state"',
    "tagStateScopeIdentity(identity.tag, identity.tagProjector)",
    "tag_state_source_frontier_failure",
    "tag_state_cache_corrupt",
    "payload: projected.payload",
    "projectorVersion: projector.projectorVersion",
  ]) requireContains(readRoute, token, "tag-state read route");
  requireAbsent(readRoute, "this.ensureWindowDeterminate()", "tag-state read route");
  requireAbsent(readRoute, "this.readTag(", "tag-state read route");

  for (const source of [runtime, cloudflare]) {
    requireContains(source, "configureTagStateProjectorRegistry(composition.projectors)", "runtime composition registry");
    requireContains(source, "TAG_STATE: DurableObjectNamespace", "runtime TagState binding");
    requireContains(source, 'tagMatch[3]?.startsWith("/__internal/g46/")', "runtime private G46 source guard");
  }

  for (const [name, config] of [["wrangler.jsonc", rootConfig], ...sampleConfigs]) {
    // The issue's in-place target explicitly names the normal root/sample
    // wrangler manifests. G38's sealed primary and its retired G32/G38
    // configurations stay untouched; broadening this migration into those
    // artifacts would be a compatibility rollout rather than this C-0 slice.
    if (name !== "wrangler.jsonc") continue;
    if (!config.includes('"class_name": "TagDurableObject"')) continue;
    requireContains(config, '"class_name": "TagStateDurableObject"', `${name} TagState binding`);
    requireContains(config, '"new_sqlite_classes": ["TagStateDurableObject"]', `${name} TagState migration`);
  }

  // AC2/AC3/AC4/AC5 fixtures cover the real source, normal delta, frozen
  // frontier, checkpoint boundaries, distinct failures, composed projectors,
  // source measurement, and the all-points anti-spike oracle.
  for (const token of [
    "committing to TagDurableObject performs zero projector work",
    "does not expose the bounded G43 source adapter",
    "uses the actual private Tag DO G43 source",
    "lacks the runtime composition registry",
    "single bounded G43 source adapter",
    "freezes the first source frontier",
    "replays an author-version mismatch from origin",
    "resumes an after-checkpoint interruption",
    "never serves an incomplete replay accumulator",
    "crash happens immediately before the checkpoint transaction",
    "lost response after a completed checkpoint",
    "cache corruption as a typed non-success",
    "source frontier failure as a distinct typed non-success",
    "projector registry failure as a distinct typed non-success",
    "unknown projector as a distinct typed non-success",
    "composition-selected projector authority",
    "every history point and consumes every cursor",
    "intermediate source-row spike",
  ]) requireContains(test, token, "G46 fixture inventory");

  for (const token of [
    "SDT-G46 TagStateDO evidence",
    "readHeadFacts",
    "G43 incremental source",
    "tag_state_source_frontier_failure",
    "Read-response compatibility",
    "AC8",
    "deferred",
    "test DB may be reset",
    "not an O(1) claim",
  ]) requireContains(evidence, token, "G46 evidence");

  requireContains(packageJson, '"test:g46"', "package scripts");
  requireContains(ci, "ci-g46:", "G46 CI lane");
  requireContains(ci, "ci-g46", "G46 verify dependency");
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try {
    assertG46TagStateContract(value);
  } catch {
    return;
  }
  fail(`forced-red mutation was accepted: ${label}`);
}

function selfTest() {
  assertG46TagStateContract(snapshot());
  expectRed((value) => { value.tag = value.tag.replace("const facts = this.readHeadFacts(input.tag);", "const facts = undefined;"); }, "G45 head facts are bypassed");
  expectRed((value) => { value.runtime = value.runtime.replace('tagMatch[3]?.startsWith("/__internal/g46/")', 'tagMatch[3]?.startsWith("/__internal/g47/")'); }, "G46 source adapter becomes publicly routable");
  expectRed((value) => { value.tagState = value.tagState.replace("/__internal/g46/tag-state-incremental", "/state"); }, "bounded source regresses to full state");
  expectRed((value) => { value.tagState = value.tagState.replace("this.readSource(identity, cache.lastSuid, undefined)", 'this.readSource(identity, "", undefined)'); }, "normal delta reprojects from the origin");
  expectRed((value) => { value.readWorker = value.readWorker.replace("this.env.TAG_STATE.get", "this.env.TAG.get"); }, "read route bypasses TagStateDO");
  expectRed((value) => { value.test = value.test.replaceAll("intermediate source-row spike", "endpoint-only source-row check"); }, "all-points source measurement fixture is removed");
  expectRed((value) => { value.evidence = value.evidence.replace("test DB may be reset", "legacy data is preserved"); }, "C-0 scope disclosure is removed");
  process.stdout.write(`${JSON.stringify({ selfTest: "g46-tagstate-contract-mutations-red" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG46TagStateContract(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g46-tagstate-contract-passed" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

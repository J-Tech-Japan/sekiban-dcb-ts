#!/usr/bin/env node
/** SDT-G35 source guard: DO scope census + confused-deputy authority surfaces. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

const LEGACY_NAME_PATTERNS = Object.freeze([
  "service-allocator:",
  "allocatorNameForService",
  "tagStateObjectName",
  "idFromName(`${serviceId}|",
  "idFromName(`${input.serviceId}|",
  'idFromName("${serviceId}|',
  "idFromName(serviceId)",
  "idFromName(pathServiceId)",
]);

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G35 DO scope contract check failed: ${message}`);
}

function requireContains(source, token, label) {
  if (!source.includes(token)) fail(`${label} is missing ${JSON.stringify(token)}`);
}

function requireAbsent(source, token, label) {
  if (source.includes(token)) fail(`${label} must not contain ${JSON.stringify(token)}`);
}

function sourceFiles(directory) {
  const absolute = resolve(root, directory);
  const result = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const file = resolve(absolute, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(relative(root, file)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(relative(root, file));
  }
  return result.sort();
}

function snapshot() {
  return {
    runtimeFiles: sourceFiles("packages/dcb-runtime/src").map((path) => [path, read(path)]),
    sampleFiles: sourceFiles("samples/meeting-room/src").map((path) => [path, read(path)]),
    scope: read("packages/dcb-runtime/src/scope/ScopeName.ts"),
    control: read("packages/dcb-runtime/src/scope/ControlRouteScope.ts"),
    commit: read("packages/dcb-runtime/src/commit/CommitWorker.ts"),
    repair: read("packages/dcb-runtime/src/repair/RepairWorker.ts"),
    drain: read("packages/dcb-runtime/src/downstream/OutboxDrain.ts"),
    journal: read("packages/dcb-runtime/src/journal/JournalDurableObject.ts"),
    runtime: read("packages/dcb-runtime/src/index.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"),
    test: read("test/g35-do-scope.spec.ts"),
    evidence: read("docs/SDT-G35-evidence.md"),
    packageJson: read("package.json"),
    laneManifest: JSON.parse(read("ci/lanes.json")),
  };
}

function manifestCommand(manifest, laneName, commandId) {
  const lane = manifest?.lanes?.find((entry) => entry?.name === laneName);
  return lane?.commands?.find((entry) => entry?.id === commandId) ?? null;
}

function censusCallSites(files) {
  const sites = [];
  for (const [path, source] of files) {
    if (path === "packages/dcb-runtime/src/scope/ScopeName.ts") continue;
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (line.includes(".idFromName(")) {
        sites.push({ path, line: index + 1, text: line.trim() });
      }
    });
  }
  return sites;
}

export function assertG35DoScopeContract(value) {
  for (const token of [
    "export function buildScopeName",
    "export function scopeIdFor",
    "${serviceId}/${doClass}/${identity}",
  ]) requireContains(value.scope, token, "canonical scope grammar");

  for (const token of [
    'code: "scope.mismatch"',
    'code: "scope.identity_missing"',
    "input.pathServiceId !== actual",
  ]) requireContains(value.control, token, "control-route enforcement");

  for (const [path, source] of [...value.runtimeFiles, ...value.sampleFiles]) {
    if (path === "packages/dcb-runtime/src/scope/ScopeName.ts") continue;
    requireAbsent(source, ".idFromName(", `${path} direct Durable Object naming`);
    for (const legacy of LEGACY_NAME_PATTERNS) {
      requireAbsent(source, legacy, `${path} legacy DO naming`);
    }
  }

  const directSites = censusCallSites([...value.runtimeFiles, ...value.sampleFiles]);
  if (directSites.length > 0) {
    fail(`direct idFromName census non-empty: ${JSON.stringify(directSites)}`);
  }

  for (const token of [
    "serviceId: this.serviceId",
    "scopeIdFor(this.env.TAG",
    "scopeIdFor(this.env.ALLOCATOR",
  ]) requireContains(value.commit, token, "CommitWorker authority addressing");
  requireAbsent(value.commit, "body.serviceId", "CommitWorker body serviceId addressing");
  requireAbsent(value.commit, "commitContext.serviceId", "CommitWorker commitContext addressing");

  for (const token of [
    "serviceId: this.serviceId",
    "scopeIdFor(this.env.TAG",
    "scopeIdFor(this.env.JOURNAL",
  ]) requireContains(value.repair, token, "RepairWorker authority addressing");

  for (const token of [
    "serviceIdentityProvider",
    "requestedServiceId !== authority",
    'route: "outbox-drain"',
    "serviceId: authority",
  ]) requireContains(value.drain, token, "OutboxDrain authority gate");
  requireAbsent(value.drain, "serviceId: requestedServiceId", "OutboxDrain body naming authority");

  requireAbsent(value.journal, "ALLOCATOR", "JournalDurableObject must not address ALLOCATOR");
  requireAbsent(value.journal, "scopeIdFor", "JournalDurableObject must not address peer DOs");
  requireAbsent(value.journal, "commitContext.serviceId", "JournalDurableObject commitContext naming");

  for (const source of [value.runtime, value.cloudflare]) {
    requireContains(source, "serviceIdentityProvider: serviceIdentity", "drain provider wiring");
    requireContains(source, "scopeIdFor(env.JOURNAL", "journal control route scoped naming");
    requireContains(source, "serviceId: requestServiceId", "journal/allocator request authority");
  }

  for (const token of [
    "rejects outbox-drain body serviceId that is not caller authority",
    "addresses outbox-drain through caller authority even when body repeats it",
    "journal control route names include caller authority serviceId",
    "rejects control-route path serviceId that is not caller authority",
  ]) requireContains(value.test, token, "G35 confused-deputy fixtures");

  for (const token of [
    "means/18 requirement 1",
    "means/18 requirement 4",
    "CF-CODE-1 WAIT",
    "scope fence",
  ]) requireContains(value.evidence, token, "G35 Cloud-facing evidence");

  requireContains(value.packageJson, '"test:g35"', "G35 package lane");
  const lane = manifestCommand(value.laneManifest, "cheap", "g35");
  const red = manifestCommand(value.laneManifest, "cheap", "g35-red");
  const wiring = lane?.command === "npm run test:g35"
    && red?.command === "npm run test:g35:forced-red"
    && red?.env?.SDT_G35_FORCE_FAILURE === "1"
    && red?.expect === "red";
  if (!wiring) fail("G35 lane and forced-red proof are absent from the authoritative lane manifest");
}

function expectRed(value, mutate, label) {
  const candidate = { ...value };
  mutate(candidate);
  try {
    assertG35DoScopeContract(candidate);
  } catch {
    return;
  }
  fail(`self-test mutation unexpectedly passed: ${label}`);
}

function main() {
  const value = snapshot();
  assertG35DoScopeContract(value);
  if (process.argv.includes("--self-test")) {
    expectRed(value, (candidate) => {
      candidate.drain = candidate.drain.replace("serviceId: authority", "serviceId: requestedServiceId");
    }, "drain body authority restored");
    expectRed(value, (candidate) => {
      candidate.commit = candidate.commit.replaceAll("serviceId: this.serviceId", "serviceId: body.serviceId");
    }, "commit authority removed");
    expectRed(value, (candidate) => {
      candidate.runtimeFiles = candidate.runtimeFiles.map(([path, source]) => [
        path,
        path.endsWith("OutboxDrain.ts")
          ? source.replace("serviceId: authority", "serviceId: requestedServiceId")
          : source,
      ]);
      candidate.drain = candidate.drain.replace("serviceId: authority", "serviceId: requestedServiceId");
    }, "runtime census body naming");
    process.stdout.write(`${JSON.stringify({ selfTest: "g35-do-scope-contract-mutations-red" })}\n`);
  }
  const census = {
    runtimeFiles: value.runtimeFiles.length,
    sampleFiles: value.sampleFiles.length,
    directIdFromNameOutsideScopeName: 0,
    legacyGrammarsAbsent: true,
  };
  process.stdout.write(`${JSON.stringify({ result: "g35-do-scope-contract-passed", census })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

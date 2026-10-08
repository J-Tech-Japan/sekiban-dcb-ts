#!/usr/bin/env node
/** SDT-G53 source guard for canonical scoped Durable Object identities. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G53 scope/identity contract check failed: ${message}`);
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
  const runtimeFiles = sourceFiles("packages/dcb-runtime/src");
  const sampleFiles = sourceFiles("samples/meeting-room/src");
  return {
    runtimeFiles: runtimeFiles.map((path) => [path, read(path)]),
    sampleFiles: sampleFiles.map((path) => [path, read(path)]),
    scope: read("packages/dcb-runtime/src/scope/ScopeName.ts"),
    provider: read("packages/dcb-runtime/src/service/ServiceIdentityProvider.ts"),
    control: read("packages/dcb-runtime/src/scope/ControlRouteScope.ts"),
    runtime: read("packages/dcb-runtime/src/index.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"),
    test: read("test/g53-scope-identity.spec.ts"),
    downstreamTest: read("test/g44-global-completeness.spec.ts"),
    downstreamMutation: read("scripts/g53-downstream-scope-mutation-runner.mjs"),
    packageJson: read("package.json"),
    ci: read(".github/workflows/ci.yml"),
    laneManifest: JSON.parse(read("ci/lanes.json")),
  };
}

function manifestCommand(manifest, laneName, commandId) {
  const lane = manifest?.lanes?.find((entry) => entry?.name === laneName);
  return lane?.commands?.find((entry) => entry?.id === commandId) ?? null;
}

export function assertG53ScopeIdentityContract(value) {
  for (const token of [
    "export function buildScopeName",
    "export function parseScopeName",
    "${serviceId}/${doClass}/${identity}",
    '"tag-state"',
    '"allocator"',
    '"bootstrap"',
    '"journal"',
    "identity.includes(\"/\")",
    "namespace.idFromName(buildScopeName(scope))",
  ]) requireContains(value.scope, token, "scope grammar");

  for (const token of [
    "export function envServiceIdentity",
    "export function injectableServiceIdentity",
    "TEST_SERVICE_ID_HEADER",
    "G11_SERVICE_ID_HEADER",
    "ServiceIdentityMissingError",
    "hostname.endsWith(\".test\")",
  ]) requireContains(value.provider, token, "ServiceIdentityProvider");

  for (const token of [
    'code: "scope.mismatch"',
    'code: "scope.identity_missing"',
    "console.warn",
    "input.pathServiceId !== actual",
  ]) requireContains(value.control, token, "control route failure contract");

  for (const source of [value.runtime, value.cloudflare]) {
    requireContains(source, "serviceIdentityProvider?: ServiceIdentityProvider", "runtime provider seam");
    requireContains(source, "enforceControlRouteScope({", "control route provider comparison");
    requireContains(source, "scopeIdFor", "runtime scope name call");
  }

  for (const [path, source] of [...value.runtimeFiles, ...value.sampleFiles]) {
    if (path === "packages/dcb-runtime/src/scope/ScopeName.ts") continue;
    requireAbsent(source, ".idFromName(", `${path} direct Durable Object naming`);
    requireAbsent(source, "allocatorNameForService", `${path} legacy allocator naming`);
    requireAbsent(source, "tagStateObjectName", `${path} legacy tag-state naming`);
  }

  requireContains(value.test, "rejects a control-route service mismatch before a Durable Object call", "mismatch zero-DO fixture");
  requireContains(value.test, "returns scope.identity_missing without deriving a control-route identity", "missing-identity fixture");
  requireContains(value.test, "uses the same .test and G11 request behaviour", "provider equivalence fixture");
  requireContains(value.test, "rejects every invalid scope part", "grammar negative fixture");
  requireContains(value.downstreamTest, "a canonical scoped source drains through the Queue adapter into global D1 before acknowledgement", "downstream scoped D1 fixture");
  requireContains(value.downstreamTest, "processDownstreamDelivery", "downstream Queue adapter fixture");
  requireContains(value.downstreamTest, "tagScopeName", "downstream scoped source fixture");
  requireContains(value.downstreamMutation, "outbox-drain-retired-service-pipe-tag-name", "downstream old-name mutation");
  requireContains(value.downstreamMutation, "G53 scoped Queue-to-D1 oracle", "downstream mutation oracle");
  requireContains(value.packageJson, '"test:scope:identity"', "G53 package lane");
  const manifestLane = manifestCommand(value.laneManifest, "bootstrap-and-runtime-safety", "g53");
  const manifestForcedRed = manifestCommand(value.laneManifest, "bootstrap-and-runtime-safety", "g53-red");
  const manifestWiring = manifestLane?.command === "npm run test:scope:identity" && manifestForcedRed?.command === "npm run test:scope:identity:forced-red" && manifestForcedRed?.env?.SDT_G53_FORCE_FAILURE === "1" && manifestForcedRed?.expect === "red";
  if (!manifestWiring) fail("G53 lane and forced-red proof are absent from the authoritative lane manifest");
}

function expectRed(value, mutate, label) {
  const candidate = { ...value };
  mutate(candidate);
  try {
    assertG53ScopeIdentityContract(candidate);
  } catch {
    return;
  }
  fail(`self-test mutation unexpectedly passed: ${label}`);
}

function main() {
  const value = snapshot();
  assertG53ScopeIdentityContract(value);
  if (process.argv.includes("--self-test")) {
    expectRed(value, (candidate) => {
      candidate.control = candidate.control.replace("input.pathServiceId !== actual", "false");
    }, "control comparison removed");
    expectRed(value, (candidate) => {
      candidate.control = candidate.control.replace('code: "scope.identity_missing"', 'code: "scope.mismatch"');
    }, "identity-missing typed response removed");
    expectRed(value, (candidate) => {
      candidate.scope = candidate.scope.replace("namespace.idFromName(buildScopeName(scope))", "namespace.idFromName(scope.identity)");
    }, "canonical grammar bypassed");
    expectRed(value, (candidate) => {
      candidate.downstreamTest = candidate.downstreamTest.replace(
        "a canonical scoped source drains through the Queue adapter into global D1 before acknowledgement",
        "downstream scoped fixture removed",
      );
    }, "Queue receiver adapter fixture removed");
    process.stdout.write(`${JSON.stringify({ selfTest: "g53-scope-identity-contract-mutations-red" })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ result: "g53-scope-identity-contract-passed" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

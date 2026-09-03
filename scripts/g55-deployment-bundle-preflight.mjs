#!/usr/bin/env node
/**
 * SDT-G55 deploy hygiene gate.
 *
 * A clean worktree must never inherit a parent workspace's built runtime.
 * This checks the workspace symlink, the locally rebuilt runtime, and the
 * exact Worker bundle produced from the normal Cloudflare-only config.  It is
 * deliberately a pre-deploy gate: deployment annotation alone is not proof
 * that the Worker contains the branch's runtime implementation.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const NORMAL_CONFIG = "samples/meeting-room/wrangler.cloudflare-only.jsonc";
const RUNTIME_PACKAGE = "node_modules/@sekiban/dcb-runtime";
const RUNTIME_DIST = "dist/cloudflare.js";

function fail(message) {
  throw new Error(`SDT-G55 deployment bundle preflight failed: ${message}`);
}

function requireGate(condition, message) {
  if (!condition) fail(message);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function read(path, label) {
  requireGate(existsSync(path), `${label} is missing at ${path}`);
  return readFileSync(path, "utf8");
}

function checkNormalConfig(source, configPath) {
  requireGate(configPath === NORMAL_CONFIG, `must use ${NORMAL_CONFIG}, received ${configPath}`);
  requireGate(/"name"\s*:\s*"sekiban-dcb-meeting-room-cloudflare-only"/.test(source), "normal config worker name is absent");
  requireGate(/"main"\s*:\s*"src\/worker\.cloudflare-only\.ts"/.test(source), "normal config Worker entrypoint is absent");
}

function checkRuntimeResolution(resolvedRuntime, expectedRuntime) {
  requireGate(
    resolvedRuntime === expectedRuntime,
    `@sekiban/dcb-runtime resolves to ${resolvedRuntime}, expected this worktree's ${expectedRuntime}`,
  );
}

function checkG55RuntimeMarkers(runtimeDist, bundle, metafile) {
  for (const [label, source] of [["locally rebuilt runtime", runtimeDist], ["normal-config bundle", bundle]]) {
    requireGate(source.includes("readListPage"), `${label} does not contain readListPage`);
    requireGate(source.includes("readHead"), `${label} does not contain the additive readHead response`);
    requireGate(source.includes("unsafe"), `${label} does not contain the explicit unsafe list lane`);
  }
  const inputs = Object.keys(metafile.inputs ?? {});
  requireGate(
    inputs.some((input) => input.includes("dcb-runtime") && input.includes("cloudflare")),
    "normal-config bundle metafile has no dcb-runtime cloudflare input",
  );
}

function expectMutationToFail(label, callback) {
  try {
    callback();
  } catch {
    return;
  }
  fail(`${label} mutation unexpectedly passed`);
}

function selfTest() {
  checkRuntimeResolution("/seat/packages/dcb-runtime", "/seat/packages/dcb-runtime");
  checkG55RuntimeMarkers(
    "readListPage readHead unsafe",
    "readListPage readHead unsafe",
    { inputs: { "node_modules/@sekiban/dcb-runtime/dist/cloudflare.js": {} } },
  );
  expectMutationToFail("parent-runtime-resolution", () => {
    checkRuntimeResolution("/parent/packages/dcb-runtime", "/seat/packages/dcb-runtime");
  });
  expectMutationToFail("missing-bundle-readHead", () => {
    checkG55RuntimeMarkers(
      "readListPage readHead unsafe",
      "readListPage unsafe",
      { inputs: { "node_modules/@sekiban/dcb-runtime/dist/cloudflare.js": {} } },
    );
  });
  expectMutationToFail("missing-runtime-input", () => {
    checkG55RuntimeMarkers("readListPage readHead unsafe", "readListPage readHead unsafe", { inputs: {} });
  });
  process.stdout.write(`${JSON.stringify({ selfTest: "g55-deployment-bundle-preflight", mutations: "red-as-required" })}\n`);
}

function main() {
  const root = resolve(argument("--root", process.cwd()));
  const configPath = argument("--config", NORMAL_CONFIG);
  const bundlePath = resolve(root, argument("--bundle", ".artifacts/sdt-g55-cloudflare-build/worker.js"));
  const metafilePath = resolve(root, argument("--metafile", ".artifacts/sdt-g55-cloudflare-build/bundle-meta.json"));
  const expectedRuntime = realpathSync(resolve(root, "packages/dcb-runtime"));
  const resolvedRuntime = realpathSync(resolve(root, RUNTIME_PACKAGE));
  const runtimeDistPath = resolve(resolvedRuntime, RUNTIME_DIST);
  const config = read(resolve(root, configPath), "normal config");
  const runtimeDist = read(runtimeDistPath, "locally rebuilt runtime distribution");
  const bundle = read(bundlePath, "normal-config Worker bundle");
  const metafile = JSON.parse(read(metafilePath, "normal-config Worker metafile"));

  checkNormalConfig(config, configPath);
  checkRuntimeResolution(resolvedRuntime, expectedRuntime);
  checkG55RuntimeMarkers(runtimeDist, bundle, metafile);
  process.stdout.write(`${JSON.stringify({
    gate: "sdt-g55-deployment-bundle-preflight",
    status: "pass",
    config: configPath,
    runtimeResolution: "worktree-local",
    runtimeDist: RUNTIME_DIST,
    bundle: bundlePath,
    metafile: metafilePath,
    markers: ["readListPage", "readHead", "unsafe"],
  }, null, 2)}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
